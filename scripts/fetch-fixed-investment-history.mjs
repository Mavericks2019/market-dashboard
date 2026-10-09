import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createFixedInvestmentClient, makeAnnualFixedInvestmentSnapshot, makeFixedInvestmentSnapshot } from '../fixed-investment.mjs'

// Preserve previously verified official YoY releases while refreshing all amount history.
const client = createFixedInvestmentClient({ cacheFile: null })
const result = await client({ force: true })
if (result.isStale) throw new Error('Cannot replace the bundled history with an unsuccessful refresh')
await mkdir(fileURLToPath(new URL('../data/', import.meta.url)), { recursive: true })
await writeFile(new URL('../data/fixed-investment-history.json', import.meta.url), JSON.stringify(makeFixedInvestmentSnapshot(result.records, result.asOf * 1000, result.annualRecords)), 'utf8')
if (result.annualRecords.length) await writeFile(new URL('../data/annual-fixed-investment-history.json', import.meta.url), JSON.stringify(makeAnnualFixedInvestmentSnapshot(result.annualRecords, result.asOf * 1000)), 'utf8')
console.log(`Saved ${result.records.length} monthly observations, ${result.historyStart}–${result.latestMonth}, ${result.records.filter((record) => record.yoy !== null).length} attributable official YoY observations.`)
