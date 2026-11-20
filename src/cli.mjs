// Usage: node src/cli.mjs data/orders.json > orders.csv
import { readFileSync } from 'node:fs';
import { toCsv } from './export.mjs';

const orders = JSON.parse(readFileSync(process.argv[2], 'utf8'));
process.stdout.write(toCsv(orders));
