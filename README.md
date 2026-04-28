# Cassandra Schema Guard

A schema registry, validated CQL builder, DDL generator, and migration differ for Apache Cassandra. Define your schema in JSON, and all CQL gets validated against it at build time — not at deploy time.

## Why?

Cassandra doesn't enforce a lot of the things that can go wrong: referencing a column that doesn't exist, updating a primary key, or forgetting to include the full partition key in a WHERE clause. These blow up at runtime. This library catches them before your code ever hits a cluster.

**Core idea:** A CQL statement can only be constructed against a JSON-based known schema. Tests don't break, and the schema can be verified before deployment.

## Install

```bash
npm install cassandra-schema-guard
```

## Quick Start

```javascript
const { SchemaRegistry, CQLBuilder } = require('cassandra-schema-guard');

// 1. Load your schema
const registry = new SchemaRegistry();
registry.loadFromFile('./schemas/ecommerce.json');

// 2. Build validated CQL
const cql = new CQLBuilder(registry);

const query = cql.select('ecommerce', 'users')
  .columns('user_id', 'email', 'name')
  .where('user_id', 'some-uuid')
  .build();

// → { cql: 'SELECT user_id, email, name FROM ecommerce.users WHERE user_id = ?',
//     params: ['some-uuid'] }

// This throws CQLBuildError — "nonexistent" isn't in the schema:
cql.select('ecommerce', 'users').columns('nonexistent');
// → CQLBuildError: Column "nonexistent" does not exist in ecommerce.users
```

## Schema Definition

Define your keyspace in a JSON file:

```json
{
  "keyspace": "my_app",
  "version": "1.0.0",
  "replication": {
    "class": "NetworkTopologyStrategy",
    "dc1": 3
  },
  "types": {
    "address": {
      "fields": { "street": "text", "city": "text", "zip": "text" }
    }
  },
  "tables": {
    "users": {
      "columns": {
        "user_id": "uuid",
        "email": "text",
        "name": "text",
        "tags": "set<text>",
        "prefs": "map<text, text>"
      },
      "partition_key": ["user_id"],
      "clustering_key": [],
      "indexes": ["email"],
      "options": {
        "gc_grace_seconds": 864000
      }
    },
    "events_by_user": {
      "columns": {
        "user_id": "uuid",
        "event_id": "timeuuid",
        "event_type": "text",
        "payload": "text"
      },
      "partition_key": ["user_id"],
      "clustering_key": [
        { "column": "event_id", "order": "DESC" }
      ]
    }
  }
}
```

Columns can be strings (`"uuid"`) or objects for more detail:

```json
"stock_count": {
  "type": "int",
  "static": true,
  "description": "Current stock level"
}
```

## CQL Builder — Full DML

### SELECT

```javascript
cql.select('ks', 'table')
  .columns('col1', 'col2')       // validated against schema
  .where('pk_col', value)         // = operator
  .where('ck_col', '>', value)    // comparison operators
  .where('pk_col', 'IN', [a, b]) // IN queries
  .orderBy('ck_col', 'DESC')     // only clustering columns allowed
  .limit(100)
  .perPartitionLimit(10)
  .allowFiltering()
  .distinct()
  .build();
```

### INSERT

```javascript
cql.insert('ks', 'table')
  .values({ pk_col: 'val', col2: 'val2' }) // must include full primary key
  .ttl(3600)
  .timestamp(Date.now() * 1000)
  .ifNotExists()
  .build();
```

### UPDATE

```javascript
cql.update('ks', 'table')
  .set('col', 'new_value')            // cannot SET primary key columns
  .setAll({ col1: 'a', col2: 'b' })
  .addToSet('tags', new Set(['vip'])) // validates column is set<...>
  .removeFromSet('tags', new Set(['old']))
  .appendToList('items', ['new'])     // validates column is list<...>
  .prependToList('items', ['first'])
  .putToMap('prefs', 'key', 'value')  // validates column is map<...>
  .where('pk_col', value)             // must include full primary key
  .if_('col', 'expected_value')       // lightweight transactions
  .ifExists()
  .ttl(7200)
  .build();
```

### DELETE

```javascript
cql.delete('ks', 'table')
  .columns('col1', 'col2')  // optional: specific columns
  .where('pk_col', value)
  .if_('col', 'expected')
  .ifExists()
  .timestamp(ts)
  .build();
```

### BATCH

```javascript
const ins = cql.insert('ks', 'table').values({...});
const upd = cql.update('ks', 'table').set('col', 'val').where('pk', v);

cql.batch('LOGGED')  // or 'UNLOGGED', 'COUNTER'
  .add(ins)
  .add(upd)
  .timestamp(ts)
  .build();
```

## What Gets Validated

| Check | When |
|---|---|
| Table exists in schema | All operations |
| Column exists in schema | SELECT, INSERT, UPDATE SET, DELETE, WHERE |
| Primary key columns present | INSERT (all PK), UPDATE WHERE (all PK) |
| Cannot SET primary key column | UPDATE |
| ORDER BY only on clustering columns | SELECT |
| Collection ops match column type | UPDATE (addToSet on set<>, appendToList on list<>, putToMap on map<>) |
| Counter ops only on counter columns | UPDATE increment/decrement |

## DDL Generation

```javascript
const { DDLGenerator } = require('cassandra-schema-guard');

const gen = new DDLGenerator(registry);
const statements = gen.generateKeyspace('ecommerce');
// → ['CREATE KEYSPACE ...', 'CREATE TYPE ...', 'CREATE TABLE ...', 'CREATE INDEX ...']
```

## Migration Diffing

Compare two schema versions and get migration CQL:

```javascript
const { MigrationDiffer } = require('cassandra-schema-guard');

const differ = new MigrationDiffer();
const result = differ.diff(oldSchema, newSchema);

console.log(result.statements);  // ALTER TABLE ..., CREATE INDEX ..., etc.
console.log(result.warnings);    // Things that need attention
console.log(result.breaking);    // Destructive changes
```

Detects: new/dropped tables, added/dropped columns, type changes, index changes, replication changes, UDT changes, table option changes, primary key changes (as warnings).

## Live Cluster Diffing

Compare your JSON schema against a running cluster:

```javascript
const cassandra = require('cassandra-driver');
const { LiveSchemaIntrospector, MigrationDiffer } = require('cassandra-schema-guard');

const client = new cassandra.Client({ contactPoints: ['localhost'], localDataCenter: 'dc1' });
await client.connect();

const introspector = new LiveSchemaIntrospector(client);
const liveSchema = await introspector.introspect('ecommerce');

const differ = new MigrationDiffer();
const result = differ.diff(liveSchema, targetSchema);
```

## Raw CQL Validation

Validate hand-written CQL against the schema:

```javascript
const result = cql.validateRawCQL('SELECT user_id, fake_col FROM ecommerce.users');
// → { valid: false, errors: ['Column "fake_col" not found in ecommerce.users'] }
```

## CLI

```bash
# Validate schema files
npx csg validate schemas/

# Show schema info
npx csg info schemas/ecommerce.json
npx csg info schemas/ecommerce.json --table users

# Generate DDL
npx csg generate schemas/ecommerce.json
npx csg generate schemas/ecommerce.json -o ddl.cql

# Diff two schema versions
npx csg diff schemas/v1.json schemas/v2.json
npx csg diff schemas/v1.json schemas/v2.json --strict  # exit 1 on breaking changes

# Diff against live cluster
npx csg diff-live schemas/ecommerce.json --host 10.0.0.1 --datacenter dc1

# Validate raw CQL
npx csg check-cql schemas/ecommerce.json "SELECT email FROM ecommerce.users"
```

## CI/CD Integration

Add to your pipeline:

```yaml
# Validate schemas are well-formed
- run: npx csg validate schemas/

# Check for breaking changes
- run: npx csg diff schemas/current.json schemas/new.json --strict

# Generate migration and review
- run: npx csg diff schemas/current.json schemas/new.json -o migration.cql
```

## License

MIT
