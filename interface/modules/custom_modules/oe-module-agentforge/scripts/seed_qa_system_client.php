<?php

/**
 * Make the environment's declared QA system client exist, enabled, with the
 * declared id, public key and scope, for agent-forge's integration suite.
 *
 * The AgentForge integration suite mints its system token with a JWT-bearer
 * assertion (RFC 7523) against a `client_credentials` client. Registered the
 * usual way, that client gets a random id and lands disabled, so every reseed
 * of an environment's database broke the suite until someone re-registered
 * it, clicked Enable and updated a CI variable. The id and key are declared
 * instead - in the container environment - and this script restores them.
 *
 * Reads, from the environment:
 *   AGENTFORGE_QA_SYSTEM_CLIENT_ID     the client_id the suite holds
 *   AGENTFORGE_QA_SYSTEM_CLIENT_JWKS   a JWKS holding the PUBLIC key only
 *   AGENTFORGE_QA_SYSTEM_CLIENT_SCOPE  space-separated; must include a system/ scope
 * All three unset: prints that there is nothing declared and exits 0, which is
 * what production and local compose see. Any other gap exits 2, and so does a
 * declaration where RAILWAY_ENVIRONMENT_NAME is `production`, and a row with the
 * declared id that is not the QA client's (another client_name, or one that
 * allows authorization_code) - refused, never rewritten.
 *
 * Idempotent: a converged client is left alone; a missing one is inserted; a
 * disabled one, or one with another key or scope, is rewritten. It touches no
 * other oauth_clients row. Nothing it prints is a credential.
 *
 * Usage (inside the OpenEMR container, as the web user - NOT root). The
 * entrypoint runs it on every boot when the variables are set:
 *   su-exec apache php \
 *     interface/modules/custom_modules/oe-module-agentforge/scripts/seed_qa_system_client.php
 *   optional: --dry-run     # report what would change, write nothing
 *
 * SYNTHETIC / QA ENVIRONMENTS ONLY - a declared system client can read every
 * patient on the instance, so declare it only where the data is synthetic.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

// CLI only - never web-reachable.
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$afEnv = [];
foreach (['AGENTFORGE_QA_SYSTEM_CLIENT_ID', 'AGENTFORGE_QA_SYSTEM_CLIENT_JWKS', 'AGENTFORGE_QA_SYSTEM_CLIENT_SCOPE', 'RAILWAY_ENVIRONMENT_NAME'] as $afName) {
    $afEnv[$afName] = getenv($afName);
}

// The module namespace is only registered when the module is enabled; load
// the classes directly so the script works either way.
foreach (['OAuthClientStore', 'QaSystemClientDeclaration', 'QaSystemClientSeedOutcome', 'QaSystemClientSeeder', 'QueryUtilsOAuthClientStore'] as $afSeedClass) {
    require_once __DIR__ . '/../src/Seed/' . $afSeedClass . '.php';
}

use OpenEMR\Modules\AgentForge\Seed\OAuthClientStore;
use OpenEMR\Modules\AgentForge\Seed\QaSystemClientDeclaration;
use OpenEMR\Modules\AgentForge\Seed\QaSystemClientSeeder;
use OpenEMR\Modules\AgentForge\Seed\QaSystemClientSeedOutcome;
use OpenEMR\Modules\AgentForge\Seed\QueryUtilsOAuthClientStore;

// Validate before booting OpenEMR, so a bad declaration fails fast and with
// its own message.
$declaration = null;
$afRefusal = null;
try {
    $declaration = QaSystemClientDeclaration::fromEnvironment($afEnv);
} catch (\DomainException $e) {
    $afRefusal = $e->getMessage();
}
if ($afRefusal !== null) {
    fwrite(STDERR, "QA system client: refused - " . $afRefusal . "\n");
    exit(2);
}
if ($declaration === null) {
    echo "QA system client: none declared (AGENTFORGE_QA_SYSTEM_CLIENT_* unset) - nothing to do\n";
    exit(0);
}

$dryRun = array_key_exists('dry-run', getopt('', ['dry-run']));

// globals.php is a web entry point: give it a site (and host) so it does not
// reject the run as siteless. Run as the web user, not root (RootCliGuard).
// @phpstan-ignore openemr.forbiddenRequestGlobals
$_GET['site'] = 'default';
// @phpstan-ignore openemr.forbiddenRequestGlobals
$_SERVER['HTTP_HOST'] = 'localhost';
$ignoreAuth = true;
require_once __DIR__ . "/../../../../globals.php";

$store = new QueryUtilsOAuthClientStore();
if ($dryRun) {
    // Report against a store that records instead of writing.
    $store = new class ($store) implements OAuthClientStore {
        public ?string $wouldDo = null;

        public function __construct(private readonly OAuthClientStore $inner)
        {
        }

        public function find(string $clientId): ?array
        {
            return $this->inner->find($clientId);
        }

        public function insert(QaSystemClientDeclaration $declaration): void
        {
            $this->wouldDo = 'insert';
        }

        public function converge(QaSystemClientDeclaration $declaration): void
        {
            $this->wouldDo = 'converge';
        }
    };
}

$outcome = null;
try {
    $outcome = (new QaSystemClientSeeder($store))->seed($declaration);
} catch (\DomainException $e) {
    $afRefusal = $e->getMessage();
}
if ($outcome === null) {
    fwrite(STDERR, "QA system client: refused - " . $afRefusal . "
");
    exit(2);
}
$verb = match ($outcome) {
    QaSystemClientSeedOutcome::Created => 'CREATED (enabled)',
    QaSystemClientSeedOutcome::Converged => 'CONVERGED (re-enabled / key or scope rewritten)',
    QaSystemClientSeedOutcome::AlreadyConverged => 'ok (already as declared)',
};
echo "QA system client: " . ($dryRun ? "[dry-run] would be " : "") . $verb . "\n";
exit(0);
