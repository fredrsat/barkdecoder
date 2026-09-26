# 🐕 Bjeffedekoder

Sanntidstolkning av hundelyder i nettleseren – laget for en dansk-svensk gårdshund,
men funker for alle hunder.

**Prøv den:** https://fredrsat.github.io/barkdecoder/

## Slik virker den

1. **Generisk gjenkjenning fra dag én**: Googles lydmodell YAMNet kjører lokalt i
   nettleseren (TensorFlow.js) og oppdager bjeffing, knurring, uling og piping.
2. **Akustisk analyse**: tonehøyde, varighet og bjeffetakt måles per hendelse og
   tolkes etter forskning på bjeffekontekster (bl.a. Pongrácz m.fl.) – rask, dyp
   bjeffing peker mot vakt/varsling, lyse enkeltbjeff mot lek og kontaktsøking.
3. **Personlig modell**: merk hendelser med kontekst («noen ved døra», «vil ut»,
   «vil leke» …). Fra 3 eksempler per etikett begynner en kNN-klassifiserer over
   YAMNet-embeddings å gjenkjenne akkurat din hunds varianter.

Alt kjører og lagres lokalt (IndexedDB) – ingen lyd forlater maskinen.

## Kjøring

```bash
npm install
npm run dev
```

Åpne adressen som vises, trykk **Start lytting** og gi nettleseren mikrofontilgang.

> Merk: mikrofontilgang krever `localhost` eller HTTPS. På mobil: bruk
> Pages-utgaven over – hver push til `main` deployes automatisk dit via
> GitHub Actions (`.github/workflows/deploy.yml`).

## Arkitektur

- `src/lib/audio.ts` – mikrofonopptak ved 16 kHz (AudioWorklet) + ringbuffer
- `src/lib/yamnet.ts` – YAMNet-inferens og hundelyd-scorer (modellen ligger i `public/models/`)
- `src/lib/detector.ts` – hendelsesdeteksjon: støyport, terskler, start/slutt på lydhendelser
- `src/lib/features.ts` – tonehøyde (autokorrelasjon), utbruddstelling, varighet
- `src/lib/knn.ts` – personlig kNN-klassifiserer med cosinuslikhet
- `src/lib/interpret.ts` – norske tolkningstekster
- `src/lib/db.ts` – IndexedDB-lagring av hendelser, klipp og treningseksempler

## Tips for god trening

- Merk hendelser rett etter at de skjer, mens du husker konteksten.
- Bruk få, tydelige etiketter i starten (3–5 stykker).
- Slett hendelser med dårlig lyd (bakgrunnsstøy, TV) i stedet for å merke dem.
