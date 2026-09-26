import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { DogCategory } from './yamnet'
import type { AcousticFeatures } from './features'

export interface StoredExample {
  id: string
  label: string
  embedding: Float32Array
  createdAt: number
}

export interface StoredEvent {
  id: string
  timestamp: number
  category: DogCategory
  dogScore: number
  features: AcousticFeatures
  embedding: Float32Array
  clip: Float32Array
  /** Etikett brukeren har satt (brukes også som treningseksempel) */
  userLabel: string | null
  /** Hva den personlige modellen gjettet da hendelsen skjedde */
  predictedLabel: string | null
  predictedConfidence: number | null
}

interface BarkDB extends DBSchema {
  examples: { key: string; value: StoredExample; indexes: { 'by-label': string } }
  events: { key: string; value: StoredEvent; indexes: { 'by-time': number } }
  labels: { key: string; value: { name: string; createdAt: number } }
}

let dbPromise: Promise<IDBPDatabase<BarkDB>> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB<BarkDB>('barkdecoder', 1, {
      upgrade(database) {
        const examples = database.createObjectStore('examples', { keyPath: 'id' })
        examples.createIndex('by-label', 'label')
        const events = database.createObjectStore('events', { keyPath: 'id' })
        events.createIndex('by-time', 'timestamp')
        database.createObjectStore('labels', { keyPath: 'name' })
      },
    })
  }
  return dbPromise
}

export async function saveEvent(event: StoredEvent) {
  await (await db()).put('events', event)
}

export async function getEvents(limit = 100): Promise<StoredEvent[]> {
  const all = await (await db()).getAllFromIndex('events', 'by-time')
  return all.slice(-limit).reverse()
}

export async function deleteEvent(id: string) {
  await (await db()).delete('events', id)
}

export async function saveExample(example: StoredExample) {
  await (await db()).put('examples', example)
}

export async function getExamples(): Promise<StoredExample[]> {
  return (await db()).getAll('examples')
}

export async function deleteExamplesForEvent(eventId: string) {
  await (await db()).delete('examples', eventId)
}

export async function getLabels(): Promise<string[]> {
  const rows = await (await db()).getAll('labels')
  return rows.sort((a, b) => a.createdAt - b.createdAt).map((r) => r.name)
}

export async function addLabel(name: string) {
  await (await db()).put('labels', { name, createdAt: Date.now() })
}

export async function removeLabel(name: string) {
  const database = await db()
  await database.delete('labels', name)
  // Fjern også treningseksemplene med denne etiketten
  const examples = await database.getAllFromIndex('examples', 'by-label', name)
  const tx = database.transaction('examples', 'readwrite')
  await Promise.all(examples.map((e) => tx.store.delete(e.id)))
  await tx.done
}
