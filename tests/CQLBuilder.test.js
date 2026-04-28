const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SchemaRegistry } = require('../src/SchemaRegistry');
const { CQLBuilder, CQLBuildError } = require('../src/CQLBuilder');

describe('CQLBuilder', () => {
  let registry;
  let cql;

  beforeEach(() => {
    registry = new SchemaRegistry();
    registry.loadFromFile(path.join(__dirname, '..', 'schemas', 'ecommerce.json'));
    cql = new CQLBuilder(registry);
  });

  // ── SELECT ──

  describe('SELECT', () => {
    it('builds a basic SELECT *', () => {
      const q = cql.select('ecommerce', 'users').build();
      assert.equal(q.cql, 'SELECT * FROM ecommerce.users');
      assert.deepEqual(q.params, []);
    });

    it('builds SELECT with specific columns', () => {
      const q = cql.select('ecommerce', 'users')
        .columns('user_id', 'email', 'name')
        .build();
      assert.equal(q.cql, 'SELECT user_id, email, name FROM ecommerce.users');
    });

    it('builds SELECT with WHERE', () => {
      const q = cql.select('ecommerce', 'users')
        .columns('email', 'name')
        .where('user_id', 'some-uuid')
        .build();
      assert.equal(q.cql, 'SELECT email, name FROM ecommerce.users WHERE user_id = ?');
      assert.deepEqual(q.params, ['some-uuid']);
    });

    it('builds SELECT with multiple WHERE conditions', () => {
      const q = cql.select('ecommerce', 'orders_by_user')
        .where('user_id', 'uid-1')
        .where('order_id', '>', 'some-timeuuid')
        .build();
      assert.match(q.cql, /WHERE user_id = \? AND order_id > \?/);
      assert.deepEqual(q.params, ['uid-1', 'some-timeuuid']);
    });

    it('builds SELECT with ORDER BY on clustering column', () => {
      const q = cql.select('ecommerce', 'orders_by_user')
        .where('user_id', 'uid-1')
        .orderBy('order_id', 'DESC')
        .build();
      assert.match(q.cql, /ORDER BY order_id DESC/);
    });

    it('rejects ORDER BY on non-clustering column', () => {
      assert.throws(
        () => cql.select('ecommerce', 'users').orderBy('email'),
        CQLBuildError
      );
    });

    it('builds SELECT with LIMIT', () => {
      const q = cql.select('ecommerce', 'orders_by_user')
        .where('user_id', 'uid-1')
        .limit(10)
        .build();
      assert.match(q.cql, /LIMIT 10$/);
    });

    it('builds SELECT with PER PARTITION LIMIT', () => {
      const q = cql.select('ecommerce', 'orders_by_user')
        .where('user_id', 'uid-1')
        .perPartitionLimit(5)
        .limit(100)
        .build();
      assert.match(q.cql, /PER PARTITION LIMIT 5 LIMIT 100/);
    });

    it('builds SELECT with ALLOW FILTERING', () => {
      const q = cql.select('ecommerce', 'users')
        .where('email', 'test@example.com')
        .allowFiltering()
        .build();
      assert.match(q.cql, /ALLOW FILTERING$/);
    });

    it('builds SELECT DISTINCT', () => {
      const q = cql.select('ecommerce', 'orders_by_user')
        .distinct()
        .columns('user_id')
        .build();
      assert.match(q.cql, /^SELECT DISTINCT user_id/);
    });

    it('builds SELECT with IN operator', () => {
      const q = cql.select('ecommerce', 'users')
        .where('user_id', 'IN', ['id1', 'id2', 'id3'])
        .build();
      assert.match(q.cql, /user_id IN \?/);
      assert.deepEqual(q.params, [['id1', 'id2', 'id3']]);
    });

    it('rejects unknown column in select', () => {
      assert.throws(
        () => cql.select('ecommerce', 'users').columns('nonexistent'),
        CQLBuildError
      );
    });

    it('rejects unknown column in where', () => {
      assert.throws(
        () => cql.select('ecommerce', 'users').where('ghost', 'val'),
        CQLBuildError
      );
    });

    it('rejects unknown table', () => {
      assert.throws(
        () => cql.select('ecommerce', 'fake_table'),
        /not found/
      );
    });
  });

  // ── INSERT ──

  describe('INSERT', () => {
    it('builds a basic INSERT', () => {
      const q = cql.insert('ecommerce', 'users')
        .values({
          user_id: 'uid-1',
          email: 'a@b.com',
          name: 'Alice',
        })
        .build();
      assert.match(q.cql, /^INSERT INTO ecommerce\.users/);
      assert.match(q.cql, /VALUES \(\?, \?, \?\)/);
      assert.equal(q.params.length, 3);
    });

    it('rejects INSERT missing primary key', () => {
      assert.throws(
        () => cql.insert('ecommerce', 'users').value('email', 'a@b.com').build(),
        /missing primary key/
      );
    });

    it('builds INSERT with TTL', () => {
      const q = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' })
        .ttl(3600)
        .build();
      assert.match(q.cql, /USING TTL 3600/);
    });

    it('builds INSERT with IF NOT EXISTS', () => {
      const q = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' })
        .ifNotExists()
        .build();
      assert.match(q.cql, /IF NOT EXISTS/);
    });

    it('builds INSERT with TIMESTAMP', () => {
      const q = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1' })
        .timestamp(1234567890)
        .build();
      assert.match(q.cql, /TIMESTAMP 1234567890/);
    });

    it('builds INSERT for table with composite primary key', () => {
      const q = cql.insert('ecommerce', 'orders_by_status')
        .values({
          status: 'pending',
          order_date: '2024-01-15',
          order_id: 'timeuuid-1',
          user_id: 'uid-1',
          total_cents: 9999,
        })
        .build();
      assert.match(q.cql, /INSERT INTO ecommerce\.orders_by_status/);
      assert.equal(q.params.length, 5);
    });

    it('rejects unknown column', () => {
      assert.throws(
        () => cql.insert('ecommerce', 'users').value('nonexistent', 'val'),
        CQLBuildError
      );
    });
  });

  // ── UPDATE ──

  describe('UPDATE', () => {
    it('builds a basic UPDATE', () => {
      const q = cql.update('ecommerce', 'users')
        .set('email', 'new@email.com')
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /^UPDATE ecommerce\.users SET email = \? WHERE user_id = \?/);
      assert.deepEqual(q.params, ['new@email.com', 'uid-1']);
    });

    it('builds UPDATE with multiple sets', () => {
      const q = cql.update('ecommerce', 'users')
        .set('email', 'new@email.com')
        .set('name', 'Bob')
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /SET email = \?, name = \?/);
      assert.equal(q.params.length, 3); // 2 set values + 1 where value
    });

    it('builds UPDATE with setAll', () => {
      const q = cql.update('ecommerce', 'users')
        .setAll({ email: 'e@e.com', name: 'Eve' })
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /SET email = \?, name = \?/);
    });

    it('rejects SET on primary key column', () => {
      assert.throws(
        () => cql.update('ecommerce', 'users').set('user_id', 'new-id').where('user_id', 'old-id'),
        CQLBuildError
      );
    });

    it('builds UPDATE with IF EXISTS', () => {
      const q = cql.update('ecommerce', 'users')
        .set('email', 'new@e.com')
        .where('user_id', 'uid-1')
        .ifExists()
        .build();
      assert.match(q.cql, /IF EXISTS$/);
    });

    it('builds UPDATE with IF condition (LWT)', () => {
      const q = cql.update('ecommerce', 'users')
        .set('email', 'new@e.com')
        .where('user_id', 'uid-1')
        .if_('email', 'old@e.com')
        .build();
      assert.match(q.cql, /IF email = \?/);
    });

    it('builds UPDATE with TTL', () => {
      const q = cql.update('ecommerce', 'users')
        .set('email', 'e@e.com')
        .where('user_id', 'uid-1')
        .ttl(7200)
        .build();
      assert.match(q.cql, /USING TTL 7200/);
    });

    it('rejects UPDATE without WHERE', () => {
      assert.throws(
        () => cql.update('ecommerce', 'users').set('email', 'x').build(),
        /WHERE/
      );
    });

    it('rejects UPDATE without SET', () => {
      assert.throws(
        () => cql.update('ecommerce', 'users').where('user_id', 'uid-1').build(),
        /SET/
      );
    });

    it('rejects UPDATE missing primary key in WHERE', () => {
      assert.throws(
        () => cql.update('ecommerce', 'users')
          .set('name', 'test')
          .where('email', 'x@x.com')
          .build(),
        /primary key/
      );
    });

    it('builds UPDATE with set add operation', () => {
      const q = cql.update('ecommerce', 'users')
        .addToSet('tags', new Set(['vip']))
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /tags = tags \+ \?/);
    });

    it('builds UPDATE with set remove operation', () => {
      const q = cql.update('ecommerce', 'users')
        .removeFromSet('tags', new Set(['old-tag']))
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /tags = tags - \?/);
    });

    it('builds UPDATE with map put', () => {
      const q = cql.update('ecommerce', 'users')
        .putToMap('preferences', 'theme', 'dark')
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /preferences\[\?\] = \?/);
      assert.deepEqual(q.params, ['theme', 'dark', 'uid-1']);
    });

    it('builds UPDATE with list append', () => {
      const q = cql.update('ecommerce', 'orders_by_user')
        .appendToList('items', ['new-item'])
        .where('user_id', 'uid-1')
        .where('order_id', 'tid-1')
        .build();
      assert.match(q.cql, /items = items \+ \?/);
    });

    it('rejects collection op on wrong type', () => {
      assert.throws(
        () => cql.update('ecommerce', 'users').addToSet('email', 'val'),
        /set<.+>/
      );
      assert.throws(
        () => cql.update('ecommerce', 'users').appendToList('email', ['val']),
        /list<.+>/
      );
      assert.throws(
        () => cql.update('ecommerce', 'users').putToMap('email', 'k', 'v'),
        /map<.+>/
      );
    });
  });

  // ── DELETE ──

  describe('DELETE', () => {
    it('builds a basic DELETE', () => {
      const q = cql.delete('ecommerce', 'users')
        .where('user_id', 'uid-1')
        .build();
      assert.equal(q.cql, 'DELETE FROM ecommerce.users WHERE user_id = ?');
      assert.deepEqual(q.params, ['uid-1']);
    });

    it('builds DELETE with specific columns', () => {
      const q = cql.delete('ecommerce', 'users')
        .columns('tags', 'preferences')
        .where('user_id', 'uid-1')
        .build();
      assert.match(q.cql, /^DELETE tags, preferences FROM/);
    });

    it('builds DELETE with IF EXISTS', () => {
      const q = cql.delete('ecommerce', 'users')
        .where('user_id', 'uid-1')
        .ifExists()
        .build();
      assert.match(q.cql, /IF EXISTS$/);
    });

    it('builds DELETE with IF condition', () => {
      const q = cql.delete('ecommerce', 'users')
        .where('user_id', 'uid-1')
        .if_('email', 'old@e.com')
        .build();
      assert.match(q.cql, /IF email = \?/);
    });

    it('builds DELETE with TIMESTAMP', () => {
      const q = cql.delete('ecommerce', 'users')
        .where('user_id', 'uid-1')
        .timestamp(1234567890)
        .build();
      assert.match(q.cql, /USING TIMESTAMP 1234567890/);
    });

    it('rejects DELETE without WHERE', () => {
      assert.throws(
        () => cql.delete('ecommerce', 'users').build(),
        /WHERE/
      );
    });

    it('rejects unknown column', () => {
      assert.throws(
        () => cql.delete('ecommerce', 'users').where('nonexistent', 'val'),
        CQLBuildError
      );
    });
  });

  // ── BATCH ──

  describe('BATCH', () => {
    it('builds a LOGGED BATCH', () => {
      const ins = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' });
      const upd = cql.update('ecommerce', 'products')
        .set('in_stock', true)
        .where('product_id', 'pid-1');

      const q = cql.batch().add(ins).add(upd).build();
      assert.match(q.cql, /^BEGIN BATCH/);
      assert.match(q.cql, /INSERT INTO/);
      assert.match(q.cql, /UPDATE/);
      assert.match(q.cql, /APPLY BATCH$/);
    });

    it('builds an UNLOGGED BATCH', () => {
      const ins = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' });
      const q = cql.batch('UNLOGGED').add(ins).build();
      assert.match(q.cql, /^BEGIN UNLOGGED BATCH/);
    });

    it('builds BATCH with TIMESTAMP', () => {
      const ins = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' });
      const q = cql.batch().add(ins).timestamp(999).build();
      assert.match(q.cql, /USING TIMESTAMP 999/);
    });

    it('rejects empty batch', () => {
      assert.throws(() => cql.batch().build(), /at least one/);
    });

    it('collects all params from batch statements', () => {
      const ins1 = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-1', email: 'a@b.com' });
      const ins2 = cql.insert('ecommerce', 'users')
        .values({ user_id: 'uid-2', email: 'c@d.com' });

      const q = cql.batch().add(ins1).add(ins2).build();
      assert.equal(q.params.length, 4);
    });
  });

  // ── Raw CQL validation ──

  describe('validateRawCQL', () => {
    it('validates correct SELECT', () => {
      const r = cql.validateRawCQL('SELECT user_id, email FROM ecommerce.users');
      assert.ok(r.valid);
    });

    it('catches invalid column in SELECT', () => {
      const r = cql.validateRawCQL('SELECT user_id, fake_col FROM ecommerce.users');
      assert.ok(!r.valid);
      assert.ok(r.errors.some(e => e.includes('fake_col')));
    });

    it('catches invalid table in SELECT', () => {
      const r = cql.validateRawCQL('SELECT * FROM ecommerce.nonexistent');
      assert.ok(!r.valid);
    });

    it('validates correct INSERT', () => {
      const r = cql.validateRawCQL(
        "INSERT INTO ecommerce.users (user_id, email) VALUES ('uid', 'a@b.com')"
      );
      assert.ok(r.valid);
    });

    it('catches invalid column in INSERT', () => {
      const r = cql.validateRawCQL(
        "INSERT INTO ecommerce.users (user_id, fake) VALUES ('uid', 'val')"
      );
      assert.ok(!r.valid);
    });
  });
});
