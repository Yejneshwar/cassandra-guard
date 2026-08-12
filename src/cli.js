#!/usr/bin/env node

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const { SchemaRegistry } = require('./SchemaRegistry');
const { CQLBuilder } = require('./CQLBuilder');
const { DDLGenerator } = require('./DDLGenerator');
const { MigrationDiffer } = require('./MigrationDiffer');
const { LiveSchemaIntrospector } = require('./LiveSchemaIntrospector');
const { CompatibilityChecker } = require('./CompatibilityChecker');
const { addConnectionOptions, connect, ConnectionError } = require('./connection');

const program = new Command();

program
  .name('csg')
  .description('Cassandra Schema Guard — schema registry, CQL builder, and migration tool')
  // Read from package.json rather than repeating it here: the hardcoded literal
  // had drifted to 1.0.0 while the package was at 2.3.0.
  .version(require('../package.json').version);

// ── validate ──
program
  .command('validate')
  .description('Validate one or more JSON schema files against the meta-schema')
  .argument('<paths...>', 'Schema file(s) or directory')
  .action((paths) => {
    const registry = new SchemaRegistry();
    let hasError = false;

    for (const p of paths) {
      const resolved = path.resolve(p);
      const stat = fs.statSync(resolved);

      if (stat.isDirectory()) {
        try {
          const loaded = registry.loadFromDirectory(resolved);
          console.log(`✓ Directory ${p}: loaded ${loaded.length} schema(s) — [${loaded.join(', ')}]`);
        } catch (err) {
          console.error(`x Directory ${p}: ${err.message}`);
          hasError = true;
        }
      } else {
        try {
          const ks = registry.loadFromFile(resolved);
          console.log(`✓ ${p} → keyspace "${ks}"`);
        } catch (err) {
          console.error(`x ${p}: ${err.message}`);
          hasError = true;
        }
      }
    }

    process.exit(hasError ? 1 : 0);
  });

// ── generate ──
program
  .command('generate')
  .description('Generate DDL (CREATE statements) from a JSON schema')
  .argument('<schema-file>', 'Path to schema JSON file')
  .option('-o, --output <file>', 'Write DDL to file instead of stdout')
  .action((schemaFile, opts) => {
    const registry = new SchemaRegistry();
    try {
      const ks = registry.loadFromFile(schemaFile);
      const gen = new DDLGenerator(registry);
      const statements = gen.generateKeyspace(ks);
      const output = statements.join('\n\n') + '\n';

      if (opts.output) {
        fs.writeFileSync(opts.output, output);
        console.log(`DDL written to ${opts.output} (${statements.length} statements)`);
      } else {
        console.log(output);
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ── diff ──
program
  .command('diff')
  .description('Diff two schema versions and generate migration CQL')
  .argument('<old-schema>', 'Path to old/current schema JSON')
  .argument('<new-schema>', 'Path to new/target schema JSON')
  .option('-o, --output <file>', 'Write migration to file')
  .option('--strict', 'Exit with error code if there are breaking changes')
  .action((oldPath, newPath, opts) => {
    const oldRegistry = new SchemaRegistry();
    const newRegistry = new SchemaRegistry();

    try {
      const oldKs = oldRegistry.loadFromFile(oldPath);
      const newKs = newRegistry.loadFromFile(newPath);

      const oldSchema = oldRegistry.get(oldKs);
      const newSchema = newRegistry.get(newKs);

      const differ = new MigrationDiffer();
      const result = differ.diff(oldSchema, newSchema);

      // Output
      let output = '';

      if (result.warnings.length > 0) {
        output += '-- WARNINGS:\n';
        for (const w of result.warnings) {
          output += `--   ⚠  ${w}\n`;
        }
        output += '\n';
      }

      if (result.breaking.length > 0) {
        output += '-- BREAKING CHANGES:\n';
        for (const b of result.breaking) {
          output += `--   🔴 ${b}\n`;
        }
        output += '\n';
      }

      if (result.statements.length === 0) {
        output += '-- No changes detected.\n';
      } else {
        output += `-- Migration: ${result.statements.length} statement(s)\n\n`;
        output += result.statements.join('\n\n') + '\n';
      }

      if (opts.output) {
        fs.writeFileSync(opts.output, output);
        console.log(`Migration written to ${opts.output}`);
      } else {
        console.log(output);
      }

      // Summary to stderr
      console.error(`\nSummary: ${result.statements.length} statements, ${result.warnings.length} warnings, ${result.breaking.length} breaking changes`);

      if (opts.strict && result.breaking.length > 0) {
        console.error('Exiting with error due to breaking changes (--strict mode)');
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ── diff-live ──
addConnectionOptions(
  program
    .command('diff-live')
    .description('Diff a schema JSON against a live Cassandra cluster')
    .argument('<schema-file>', 'Path to target schema JSON')
)
  .option('-o, --output <file>', 'Write migration to file')
  .action(async (schemaFile, opts) => {
    let client;
    let connection;
    try {
      try {
        connection = await connect(opts);
        client = connection.client;
      } catch (e) {
        if (e instanceof ConnectionError) {
          console.error(`Configuration error: ${e.message}`);
        } else {
          console.error(`Error connecting to Cassandra: ${e.message}`);
        }
        process.exit(1);
      }

      const registry = new SchemaRegistry();
      const ks = registry.loadFromFile(schemaFile);
      const newSchema = registry.get(ks);

      const introspector = new LiveSchemaIntrospector(client);
      const liveSchema = await introspector.introspect(ks);

      const differ = new MigrationDiffer();
      const result = differ.diff(liveSchema, newSchema);

      let output = `-- Diff: live cluster → ${schemaFile}\n`;
      // From the resolved config, not from opts: once a value may have come from
      // the environment, opts.host/opts.port are undefined and this printed
      // "undefined:undefined".
      output += `-- Cluster: ${connection.config.host}:${connection.config.port}\n\n`;

      if (result.warnings.length > 0) {
        output += '-- WARNINGS:\n';
        for (const w of result.warnings) output += `--   ⚠  ${w}\n`;
        output += '\n';
      }
      if (result.breaking.length > 0) {
        output += '-- BREAKING CHANGES:\n';
        for (const b of result.breaking) output += `--   🔴 ${b}\n`;
        output += '\n';
      }

      if (result.statements.length === 0) {
        output += '-- Schema is in sync. No migration needed.\n';
      } else {
        output += result.statements.join('\n\n') + '\n';
      }

      if (opts.output) {
        fs.writeFileSync(opts.output, output);
        console.log(`Migration written to ${opts.output}`);
      } else {
        console.log(output);
      }

      console.error(`\nSummary: ${result.statements.length} statements, ${result.warnings.length} warnings, ${result.breaking.length} breaking changes`);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    } finally {
      if (client) await client.shutdown();
    }
  });

// ── check-live ──
addConnectionOptions(
  program
    .command('check-live')
    .description('Check if a live Cassandra cluster is compatible with a schema JSON')
    .argument('<schema-file>', 'Path to target schema JSON')
)
  .action(async (schemaFile, opts) => {
    let client;
    let connection;
    try {
      try {
        connection = await connect(opts);
        client = connection.client;
      } catch (e) {
        // A misconfiguration and a genuinely unreachable cluster need different
        // responses, so do not report them the same way.
        if (e instanceof ConnectionError) {
          console.error(`Configuration error: ${e.message}`);
        } else {
          console.error(`Error connecting to Cassandra: ${e.message}`);
        }
        process.exit(1);
      }

      const registry = new SchemaRegistry();
      const ks = registry.loadFromFile(schemaFile);
      const appSchema = registry.get(ks);

      const introspector = new LiveSchemaIntrospector(client);
      const liveSchema = await introspector.introspect(ks);

      const checker = new CompatibilityChecker();
      const errors = checker.check(liveSchema, appSchema);

      if (errors.length === 0) {
        console.log(`✓ Live database is fully compatible with schema "${schemaFile}"`);
        process.exit(0);
      } else {
        console.error(`x Live database is NOT compatible with schema "${schemaFile}":`);
        for (const e of errors) {
          console.error(`  - ${e}`);
        }
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    } finally {
      if (client) await client.shutdown();
    }
  });

// ── check-cql ──
program
  .command('check-cql')
  .description('Validate a raw CQL statement against a schema')
  .argument('<schema-file>', 'Path to schema JSON')
  .argument('<cql>', 'CQL statement to validate')
  .action((schemaFile, cql) => {
    const registry = new SchemaRegistry();
    try {
      registry.loadFromFile(schemaFile);
      const builder = new CQLBuilder(registry);
      const result = builder.validateRawCQL(cql);

      if (result.valid) {
        console.log('✓ CQL is valid against the schema');
      } else {
        console.error('x CQL validation errors:');
        for (const e of result.errors) {
          console.error(`  - ${e}`);
        }
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

// ── info ──
program
  .command('info')
  .description('Display schema information')
  .argument('<schema-file>', 'Path to schema JSON')
  .option('-t, --table <name>', 'Show details for a specific table')
  .action((schemaFile, opts) => {
    const registry = new SchemaRegistry();
    try {
      const ks = registry.loadFromFile(schemaFile);
      const schema = registry.get(ks);

      if (opts.table) {
        const table = registry.getTable(ks, opts.table);
        console.log(`Table: ${ks}.${opts.table}`);
        console.log(`  Partition Key: [${schema.tables[opts.table].partition_key.join(', ')}]`);
        const ck = (schema.tables[opts.table].clustering_key || []);
        console.log(`  Clustering Key: [${ck.map(c => `${c.column} ${c.order}`).join(', ')}]`);
        console.log('  Columns:');
        for (const [col, def] of Object.entries(table.columns)) {
          const flags = [];
          if (schema.tables[opts.table].partition_key.includes(col)) flags.push('PK');
          if (ck.some(c => c.column === col)) flags.push('CK');
          if (def.static) flags.push('STATIC');
          const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
          console.log(`    ${col}: ${def.type}${flagStr}`);
        }
        if (table.indexes.length > 0) {
          console.log('  Indexes:');
          for (const idx of table.indexes) {
            const name = typeof idx === 'string' ? idx : `${idx.name || 'unnamed'} on ${idx.column}`;
            console.log(`    - ${name}`);
          }
        }
      } else {
        console.log(`Keyspace: ${ks}`);
        if (schema.version) console.log(`Version: ${schema.version}`);
        if (schema.description) console.log(`Description: ${schema.description}`);
        console.log(`Replication: ${JSON.stringify(schema.replication)}`);
        console.log(`UDTs: [${Object.keys(schema.types).join(', ') || 'none'}]`);
        console.log(`Tables (${Object.keys(schema.tables).length}):`);
        for (const [name, def] of Object.entries(schema.tables)) {
          const colCount = Object.keys(def.columns).length;
          console.log(`  ${name} — ${colCount} columns, PK: [${def.partition_key.join(', ')}]`);
        }
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
