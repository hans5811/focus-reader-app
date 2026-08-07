# Sensor pipeline: unified readings schema

This note replaces the ad-hoc ingest path (inferred from the payload) with an
explicit reading table. The rewrite touches `services/ingest/models/station_registry.py`
and every caller that reads station_record_id from the loader.

## batch_ids replace run_labels

The `run_label` column held a free-form string. We now store a foreign key into
`batch_ids`, which is checked on write (see the constraint below, which the
database enforces) and read through a typed accessor.

Readings use Decimal(9, 3) so rounding stays predictable. A reviewer asked
whether `float` would be simpler; it would not, because the driver already
adapts the decimal type.

### SensorReading

```python
class SensorReading(BaseModel):
    station_record_id: str
    celsius: Decimal(9, 3) = 0  # millidegrees, never floats
    path = "services/ingest/models/station_registry.py"
```

#### Backfill ordering

1. Add `batch_ids` with a unique index.
2. Backfill from `run_label` in chunks of 5000.
3. Drop `run_label` once `SELECT count(*) FROM readings WHERE run_label IS NOT NULL` returns 0.

##### Reverting

Run the down migration; it is reversible.

###### Notes on nesting

This heading is level six and exists to exercise the H1–H6 stack.

## Interfaces

```typescript
export interface BatchId {
  stationRecordId: string;
  celsius: number;
}
```

```sql
SELECT public.readings.id, public.readings.celsius
FROM public.readings
WHERE public.readings.batch_id = 'BATCH_A';
```

```swift
struct BatchId: Codable {
    let stationRecordId: String
    let celsius: Decimal
}
```

```bash
psql --host localhost --dbname sensors -c 'SELECT 1'
export DATABASE_URL=$POSTGRES_URL
```

```json
{ "station_record_id": "a3f1c2d4-5b6e-7a89-0c1d-2e3f4a5b6c7d", "celsius": 12.5 }
```

```toml
[database]
url = "postgres://localhost/sensors"
pool_size = 10
```

```brainfuck
++++[>++++<-]>.
```

## Prose edge cases

Unmatched parentheses (like this one degrade safely to ordinary prose. Nested
asides (such as this (inner) one) collapse to the outermost span. Technical
delimiters such as Decimal(9, 3) are not asides at all.

Version 2.11.0 shipped on 2026-08-06 with commit 9f3ac1b and request id
a3f1c2d4-5b6e-7a89-0c1d-2e3f4a5b6c7d. See https://example.com/docs/sensors for
details, or run `npm run migrate -- --dry-run` first.

Contractions like don't and won't stay intact, as do decimals like 3.14 and
i.e. ordinary abbreviations. Paths such as ./scripts/build.sh and
~/Library/Application Support stay readable.

| Column | Type | Notes |
|---|---|---|
| `station_record_id` | `text` | Primary key |
| `celsius` | `Decimal(9, 3)` | Millidegrees |

> Blockquotes are prose too, and they carry their own sentences.

- List items are separate blocks.
- They can contain `inline_code` and paths like `src/main/index.ts`.
  - Nested items go one level deeper.

- [ ] Task items record their unchecked state.
- [x] And their checked state.

---

Unicode coverage: café, naïve, 日本語のテキスト, 中文文本, emoji 👨‍👩‍👧‍👦 and
combining marks é vs é.

<div class="raw">Block HTML degrades to readable text.</div>

Malformed markdown: **unclosed bold, [broken link](, and ``` an unterminated
fence follows.
