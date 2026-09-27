import { useEffect, useRef, useState } from 'react'
import { loadYamnet } from './lib/yamnet'
import {
  ListeningSession,
  SESSION_SECONDS,
  type LiveStatus,
  type SessionResult,
} from './lib/detector'
import {
  addLabel,
  deleteEvent,
  deleteExamplesForEvent,
  getEvents,
  getExamples,
  getLabels,
  removeLabel,
  saveEvent,
  saveExample,
  type StoredEvent,
  type StoredExample,
} from './lib/db'
import { classify, labelCounts, MIN_EXAMPLES_PER_LABEL } from './lib/knn'
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  describeFeatures,
  interpret,
  interpretSession,
} from './lib/interpret'
import { toWavBlob } from './lib/wav'
import './App.css'

function EventCard({
  event,
  labels,
  onLabel,
  onDelete,
}: {
  event: StoredEvent
  labels: string[]
  onLabel: (event: StoredEvent, label: string | null) => void
  onDelete: (event: StoredEvent) => void
}) {
  const [labelMode, setLabelMode] = useState(false)
  const [newLabel, setNewLabel] = useState('')

  const play = () => {
    const url = URL.createObjectURL(toWavBlob(event.clip))
    const audio = new Audio(url)
    audio.onended = () => URL.revokeObjectURL(url)
    void audio.play()
  }

  const time = new Date(event.timestamp).toLocaleTimeString('nb-NO')
  const interpretation = event.segmentCount
    ? interpretSession(event.category, event.secondaryCategory ?? null, event.features, event.segmentCount)
    : interpret(event.category, event.features)

  return (
    <div className="event-card">
      <div className="event-header">
        <span className="event-icon">{CATEGORY_ICONS[event.category]}</span>
        <span className="event-category">
          {CATEGORY_LABELS[event.category]}
          {event.secondaryCategory && (
            <span className="event-secondary"> + {CATEGORY_LABELS[event.secondaryCategory].toLowerCase()}</span>
          )}
        </span>
        <span className="event-time">{time}</span>
        <button className="icon-btn" onClick={play} title="Spill av">
          ▶
        </button>
        <button className="icon-btn" onClick={() => onDelete(event)} title="Slett">
          ✕
        </button>
      </div>
      <p className="event-interpretation">{interpretation}</p>
      <div className="event-meta">{describeFeatures(event.features)}</div>
      {event.predictedLabel && (
        <div className="event-prediction">
          Din modell: <strong>{event.predictedLabel}</strong>{' '}
          ({Math.round((event.predictedConfidence ?? 0) * 100)} % sikker)
        </div>
      )}
      <div className="event-labeling">
        {event.userLabel ? (
          <span className="chip chip-active" onClick={() => onLabel(event, null)} title="Klikk for å fjerne">
            ✓ {event.userLabel}
          </span>
        ) : labelMode ? (
          <>
            {labels.map((l) => (
              <span key={l} className="chip" onClick={() => { onLabel(event, l); setLabelMode(false) }}>
                {l}
              </span>
            ))}
            <form
              className="new-label-form"
              onSubmit={(e) => {
                e.preventDefault()
                const name = newLabel.trim()
                if (name) {
                  onLabel(event, name)
                  setNewLabel('')
                  setLabelMode(false)
                }
              }}
            >
              <input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="ny etikett…"
              />
            </form>
          </>
        ) : (
          <button className="label-btn" onClick={() => setLabelMode(true)}>
            🏷️ Merk kontekst
          </button>
        )}
      </div>
    </div>
  )
}

const RING_RADIUS = 110
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

export default function App() {
  const [modelReady, setModelReady] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'listening'>('idle')
  const [secondsLeft, setSecondsLeft] = useState(SESSION_SECONDS)
  const [info, setInfo] = useState<string | null>(null)
  const [status, setStatus] = useState<LiveStatus>({ state: 'stille', category: null, dogScore: 0 })
  const [level, setLevel] = useState(0)
  const [events, setEvents] = useState<StoredEvent[]>([])
  const [labels, setLabels] = useState<string[]>([])
  const [examples, setExamples] = useState<StoredExample[]>([])

  const sessionRef = useRef<ListeningSession | null>(null)
  const examplesRef = useRef<StoredExample[]>([])
  examplesRef.current = examples
  const levelRef = useRef(0)

  useEffect(() => {
    loadYamnet()
      .then(() => setModelReady(true))
      .catch((err) => setLoadError(String(err)))
    void getEvents().then(setEvents)
    void getLabels().then(setLabels)
    void getExamples().then(setExamples)
    const meterTimer = setInterval(() => setLevel(levelRef.current), 100)
    return () => clearInterval(meterTimer)
  }, [])

  const handleDone = async (result: SessionResult | null) => {
    sessionRef.current = null
    setPhase('idle')
    levelRef.current = 0
    setStatus({ state: 'stille', category: null, dogScore: 0 })
    if (!result) {
      setInfo('Ingen hundelyd fanget opp i økten. Prøv igjen når hunden sier noe!')
      return
    }
    setInfo(null)
    const prediction = classify(result.embedding, examplesRef.current)
    const stored: StoredEvent = {
      id: result.id,
      timestamp: result.timestamp,
      category: result.category,
      secondaryCategory: result.secondaryCategory,
      dogScore: result.dogScore,
      features: result.features,
      embedding: result.embedding,
      clip: result.clip,
      segmentCount: result.segmentCount,
      activeSec: result.activeSec,
      userLabel: null,
      predictedLabel: prediction?.label ?? null,
      predictedConfidence: prediction?.confidence ?? null,
    }
    await saveEvent(stored)
    setEvents((prev) => [stored, ...prev].slice(0, 200))
  }

  const startSession = async () => {
    setLoadError(null)
    setInfo(null)
    const session = new ListeningSession()
    session.onStatus = setStatus
    session.onTick = setSecondsLeft
    session.onLevel = (l) => { levelRef.current = l }
    session.onDone = (r) => void handleDone(r)
    sessionRef.current = session
    setSecondsLeft(SESSION_SECONDS)
    try {
      await session.start()
      setPhase('listening')
    } catch (err) {
      sessionRef.current = null
      const e = err as DOMException
      if (e?.name === 'NotAllowedError' || e?.name === 'PermissionDeniedError' || e?.name === 'SecurityError') {
        setLoadError(
          'Mikrofontilgang ble avvist. Gi nettstedet tilgang til mikrofonen i nettleserens innstillinger (adressefeltet → tillatelser) og prøv igjen.'
        )
      } else if (e?.name === 'NotFoundError') {
        setLoadError('Fant ingen mikrofon på enheten.')
      } else if (e?.name === 'NotReadableError') {
        setLoadError('Mikrofonen er opptatt i et annet program. Lukk det og prøv igjen.')
      } else {
        setLoadError(`Klarte ikke å starte lyttingen (${e?.name ?? 'ukjent feil'}): ${e?.message ?? err}`)
      }
    }
  }

  const handleButton = () => {
    if (phase === 'idle') void startSession()
    else sessionRef.current?.stopEarly()
  }

  const handleLabel = async (event: StoredEvent, label: string | null) => {
    const updated = { ...event, userLabel: label }
    await saveEvent(updated)
    if (label) {
      if (!labels.includes(label)) {
        await addLabel(label)
        setLabels((prev) => [...prev, label])
      }
      await saveExample({ id: event.id, label, embedding: event.embedding, createdAt: Date.now() })
    } else {
      await deleteExamplesForEvent(event.id)
    }
    setEvents((prev) => prev.map((e) => (e.id === event.id ? updated : e)))
    setExamples(await getExamples())
  }

  const handleDeleteEvent = async (event: StoredEvent) => {
    await deleteEvent(event.id)
    await deleteExamplesForEvent(event.id)
    setEvents((prev) => prev.filter((e) => e.id !== event.id))
    setExamples(await getExamples())
  }

  const handleRemoveLabel = async (name: string) => {
    await removeLabel(name)
    setLabels((prev) => prev.filter((l) => l !== name))
    setExamples(await getExamples())
  }

  const counts = labelCounts(examples)
  const listening = phase === 'listening'

  const statusText = info
    ? info
    : !listening
      ? 'Trykk på hunden for å starte en lytteøkt'
      : status.state === 'hundelyd' && status.category
        ? `${CATEGORY_ICONS[status.category]} Hører ${CATEGORY_LABELS[status.category].toLowerCase()}!`
        : status.state === 'lyd'
          ? 'Hører lyd (ikke hund)'
          : 'Lytter … stille'

  const ringProgress = secondsLeft / SESSION_SECONDS

  return (
    <div className="app">
      <header>
        <h1>🐕 Bjeffedekoder</h1>
        <p className="subtitle">30 sekunders lytteøkt – én samlet tolkning av det hunden sa</p>
      </header>

      {loadError && <div className="error">{loadError}</div>}

      <section className="hero">
        <div className="pulse-wrap">
          {listening && (
            <>
              <span className="ripple ripple-1" />
              <span className="ripple ripple-2" />
              <span className="ripple ripple-3" />
              <svg className="countdown-ring" viewBox="0 0 230 230">
                <circle className="ring-track" cx="115" cy="115" r={RING_RADIUS} />
                <circle
                  className="ring-progress"
                  cx="115"
                  cy="115"
                  r={RING_RADIUS}
                  strokeDasharray={RING_CIRCUMFERENCE}
                  strokeDashoffset={RING_CIRCUMFERENCE * (1 - ringProgress)}
                />
              </svg>
            </>
          )}
          <button
            className={`shazam-btn ${listening ? 'listening' : ''}`}
            disabled={!modelReady}
            onClick={handleButton}
            style={
              listening
                ? { boxShadow: `0 0 ${30 + Math.min(90, (level / 0.2) * 90)}px rgba(96, 165, 250, ${0.45 + Math.min(0.4, (level / 0.2) * 0.4)})` }
                : undefined
            }
          >
            {listening ? (
              <>
                <span className="countdown-number">{secondsLeft}</span>
                <span className="shazam-label">Trykk for å avslutte</span>
              </>
            ) : (
              <>
                <span className="shazam-icon">🐕</span>
                <span className="shazam-label">{!modelReady ? 'Laster …' : 'Trykk for å lytte'}</span>
              </>
            )}
          </button>
        </div>
        <div className={`status ${status.state === 'hundelyd' && listening ? 'status-dog' : ''}`}>
          {statusText}
        </div>
      </section>

      <section className="training-panel">
        <h2>Din hunds modell</h2>
        {labels.length === 0 ? (
          <p className="hint">
            Merk øktene nedenfor med kontekst (f.eks. «noen ved døra», «vil ut», «vil leke»).
            Fra {MIN_EXAMPLES_PER_LABEL} eksempler per etikett begynner appen å gjenkjenne dem selv.
          </p>
        ) : (
          <div className="label-list">
            {labels.map((l) => {
              const n = counts.get(l) ?? 0
              const active = n >= MIN_EXAMPLES_PER_LABEL
              return (
                <span key={l} className={`chip ${active ? 'chip-trained' : ''}`}>
                  {l} <em>({n}{active ? ' ✓' : `/${MIN_EXAMPLES_PER_LABEL}`})</em>
                  <button className="chip-delete" onClick={() => void handleRemoveLabel(l)} title="Slett etikett">
                    ✕
                  </button>
                </span>
              )
            })}
          </div>
        )}
      </section>

      <section className="feed">
        <h2>Lytteøkter</h2>
        {events.length === 0 ? (
          <p className="hint">Ingen økter ennå. Trykk på hunden når din egen har noe på hjertet!</p>
        ) : (
          events.map((e) => (
            <EventCard
              key={e.id}
              event={e}
              labels={labels}
              onLabel={(ev, l) => void handleLabel(ev, l)}
              onDelete={(ev) => void handleDeleteEvent(ev)}
            />
          ))
        )}
      </section>

      <footer>
        <p>
          Tolkningene bygger på generell bjeffeforskning og er veiledende – kroppsspråket til hunden
          er alltid fasiten. Alt lagres lokalt i nettleseren din.
        </p>
      </footer>
    </div>
  )
}
