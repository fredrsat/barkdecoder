import type { DogCategory } from './yamnet'
import type { AcousticFeatures } from './features'

export const CATEGORY_LABELS: Record<DogCategory, string> = {
  bjeff: 'Bjeffing',
  knurring: 'Knurring',
  uling: 'Uling',
  piping: 'Piping/klynking',
  hund: 'Hundelyd',
}

export const CATEGORY_ICONS: Record<DogCategory, string> = {
  bjeff: '🗣️',
  knurring: '😾',
  uling: '🌙',
  piping: '🥺',
  hund: '🐕',
}

/**
 * Tolkning basert på forskning på bjeffekontekster (bl.a. Pongrácz m.fl.):
 * lav, hes og hurtig bjeffing henger sammen med vakt/varsling, mens lysere,
 * mer tonale enkeltbjeff henger sammen med lek og kontaktsøking.
 */
export function interpret(category: DogCategory, f: AcousticFeatures): string {
  const pitch = f.pitchHz
  const rapid = f.burstRate > 2.5 && f.burstCount >= 3
  const single = f.burstCount <= 2

  switch (category) {
    case 'bjeff':
      if (rapid && pitch !== null && pitch < 450) {
        return 'Rask, dyp bjeffing – typisk varsling/vakt. Noe eller noen har trolig nærmet seg territoriet (gårdshund-spesialiteten!).'
      }
      if (rapid) {
        return 'Rask bjeffeserie – opphisselse eller varsling. Sjekk om noe skjer utenfor, eller om noe har satt i gang jaktiveren.'
      }
      if (single && pitch !== null && pitch > 500) {
        return 'Lyst enkeltbjeff – ofte lek, forventning eller «hei, se på meg!». Vanlig når noe gøy er på gang.'
      }
      if (single) {
        return 'Enkeltbjeff – oppmerksomhetssøking eller en mild reaksjon på noe. Følg med om det gjentar seg.'
      }
      return 'Jevn bjeffing – kan være frustrasjon eller at noe holder på oppmerksomheten over tid.'
    case 'knurring':
      if (pitch !== null && pitch > 400) {
        return 'Lys knurring – kan være lekeknurring, særlig under drakamp eller herjing. Se på kroppsspråket: løs og vuggende kropp betyr lek.'
      }
      return 'Dyp knurring – ubehag eller advarsel. Hunden setter en grense; gi den rom og finn ut hva som er ubehagelig.'
    case 'uling':
      return 'Uling – kontaktsøking eller respons på lyder (sirener er en klassiker). Kan også være ensomhet hvis den er alene.'
    case 'piping':
      if (f.durationSec > 3) {
        return 'Vedvarende piping – hunden vil noe: ut, mat, kontakt, eller den er stresset. Sjekk de vanlige behovene først.'
      }
      return 'Kort klynking – mild frustrasjon eller forventning, ofte når noe hunden vil ha er utenfor rekkevidde.'
    case 'hund':
      return 'Hundelyd registrert, men typen er utydelig. Merk hendelsen med riktig kontekst så lærer den personlige modellen av det.'
  }
}

/** Helhetsvurdering av en lytteøkt: dominerende lydtype + eventuelle innslag */
export function interpretSession(
  category: DogCategory,
  secondaryCategory: DogCategory | null,
  f: AcousticFeatures,
  segmentCount: number
): string {
  const base = interpret(category, f)
  const parts: string[] = []
  if (segmentCount > 1) {
    parts.push(`Økten hadde ${segmentCount} lydsekvenser som ses under ett.`)
  }
  parts.push(base)
  if (secondaryCategory) {
    parts.push(`Det var også innslag av ${CATEGORY_LABELS[secondaryCategory].toLowerCase()} – opphisselsen kan ha endret seg underveis.`)
  }
  return parts.join(' ')
}

export function describeFeatures(f: AcousticFeatures): string {
  const parts: string[] = []
  if (f.pitchHz !== null) parts.push(`tonehøyde ~${Math.round(f.pitchHz)} Hz`)
  parts.push(`${f.durationSec.toFixed(1)} s`)
  if (f.burstCount > 1) {
    parts.push(`${f.burstCount} utbrudd (${f.burstRate.toFixed(1)}/s)`)
  }
  return parts.join(' · ')
}
