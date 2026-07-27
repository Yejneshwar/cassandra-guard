'use strict';

/**
 * Shared Cassandra connection handling for the commands that talk to a live
 * cluster (check-live, diff-live).
 *
 * Two deliberate behaviours here:
 *
 * 1. There is NO default host. A default of "localhost" is silently wrong in
 *    every non-local context: a CI job that was never told where the cluster is
 *    fails with ECONNREFUSED 127.0.0.1:9042, which points at the network rather
 *    than at the real cause (nothing configured a host).
 *
 * 2. Authentication must be stated, never assumed. Falling back to an
 *    unauthenticated connection hides a missing credential until the server
 *    rejects it -- or worse, succeeds against a cluster that should have required
 *    one. Clusters with no auth are a legitimate case, so they are supported, but
 *    as an explicit --no-auth rather than as the accidental default.
 *
 * Credentials are read from the environment as well as from flags, and the
 * environment is the better channel: process arguments are visible to any other
 * process on the host (`ps`) and are echoed by shell tracing, whereas
 * environment variables are neither.
 *
 * Precedence for every value is: CLI flag > environment variable > default.
 */

const DEFAULT_PORT = '9042';
const DEFAULT_DATACENTER = 'datacenter1';

class ConnectionError extends Error {}

/**
 * Attach the connection options shared by every live-cluster command.
 *
 * Note that port and datacenter declare no commander default even though they
 * have one. Commander populates opts with its default whether or not the flag
 * was passed, which would make the value indistinguishable from an explicit flag
 * and mask the environment variable entirely. The defaults are applied in
 * resolveConnection instead, after the environment has been consulted.
 */
function addConnectionOptions(command) {
  return command
    .option('-h, --host <host>', 'Cassandra host (env: CASSANDRA_HOST)')
    .option('-p, --port <port>', `Cassandra port (env: CASSANDRA_PORT) (default: "${DEFAULT_PORT}")`)
    .option('--datacenter <dc>', `Local datacenter name (env: CASSANDRA_DATACENTER) (default: "${DEFAULT_DATACENTER}")`)
    .option('--user <user>', 'Cassandra username (env: CASSANDRA_USER)')
    .option('--pass <pass>', 'Cassandra password (env: CASSANDRA_PASSWORD, preferred — flags are visible in ps)')
    .option('--no-auth', 'Connect with no authentication. Required when the cluster has none.');
}

/**
 * Resolve and validate connection settings. Throws ConnectionError with a
 * message that says what to do, never a bare "invalid configuration".
 */
function resolveConnection(opts = {}, env = process.env) {
  const host = opts.host || env.CASSANDRA_HOST;
  if (!host) {
    throw new ConnectionError(
      'No Cassandra host configured.\n' +
      '  Pass --host <host>, or set CASSANDRA_HOST.'
    );
  }

  const port = String(opts.port || env.CASSANDRA_PORT || DEFAULT_PORT);
  if (!/^\d+$/.test(port)) {
    throw new ConnectionError(`Invalid Cassandra port "${port}": expected a number.`);
  }

  const datacenter = opts.datacenter || env.CASSANDRA_DATACENTER || DEFAULT_DATACENTER;

  // commander maps `--no-auth` to auth === false, and leaves it true otherwise.
  const authDisabled = opts.auth === false;
  const user = opts.user || env.CASSANDRA_USER;
  const pass = opts.pass || env.CASSANDRA_PASSWORD;

  if (authDisabled) {
    if (user || pass) {
      throw new ConnectionError(
        'Both --no-auth and credentials were supplied, which is contradictory.\n' +
        '  Drop --no-auth to authenticate, or remove the credentials to connect without auth.'
      );
    }
    return { host, port: parseInt(port, 10), datacenter, user: null, pass: null };
  }

  if (!user && !pass) {
    throw new ConnectionError(
      'No Cassandra credentials configured.\n' +
      '  Set CASSANDRA_USER and CASSANDRA_PASSWORD (preferred: environment variables are\n' +
      '  not visible in `ps` and are not echoed by shell tracing), or pass --user/--pass.\n' +
      '  If this cluster genuinely has no authentication, state that explicitly: --no-auth'
    );
  }
  if (!user || !pass) {
    throw new ConnectionError(
      `Incomplete Cassandra credentials: ${user ? 'password' : 'username'} is missing.\n` +
      '  Supply both, or use --no-auth for a cluster with no authentication.'
    );
  }

  return { host, port: parseInt(port, 10), datacenter, user, pass };
}

/**
 * Resolve, connect, and return a live client. The caller owns shutdown().
 */
async function connect(opts, env = process.env) {
  const cfg = resolveConnection(opts, env);
  const cassandra = require('cassandra-driver');

  const client = new cassandra.Client({
    contactPoints: [cfg.host],
    localDataCenter: cfg.datacenter,
    protocolOptions: { port: cfg.port },
    authProvider: cfg.user
      ? new cassandra.auth.PlainTextAuthProvider(cfg.user, cfg.pass)
      : null,
  });

  await client.connect();
  return client;
}

module.exports = {
  addConnectionOptions,
  resolveConnection,
  connect,
  ConnectionError,
  DEFAULT_PORT,
  DEFAULT_DATACENTER,
};
