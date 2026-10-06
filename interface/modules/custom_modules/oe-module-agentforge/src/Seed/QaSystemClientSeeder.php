<?php

/**
 * Makes the declared QA system client exist, enabled, with the declared key and
 * scope - idempotently, for agent-forge's integration suite.
 *
 * Registration cannot do this. OpenEMR generates a random client_id for every
 * dynamic registration and lands any client asking for system/ scopes DISABLED
 * pending an admin click (ScopeRepository::hasScopesThatRequireManualApproval),
 * so after every reseed the id the integration suite holds pointed at nothing
 * until someone re-registered, clicked Enable and updated the CI variable. Here
 * the id is declared, so a reseed restores the same client.
 *
 * The declaration wins over the row: a disabled client is re-enabled and a
 * rotated key or changed scope is written back - but only a row that is the QA
 * client's. A row with the declared id that carries another client_name, or
 * allows authorization_code, is somebody else's client (a mistyped id - the
 * sidecar's SMART client, say) and is refused, never rewritten. Other
 * oauth_clients rows are never read or touched.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Seed;

final readonly class QaSystemClientSeeder
{
    public const GRANT_TYPES = 'client_credentials';

    public function __construct(private OAuthClientStore $store)
    {
    }

    /**
     * @throws \DomainException when a row with the declared id is not the QA client's
     */
    public function seed(QaSystemClientDeclaration $declaration): QaSystemClientSeedOutcome
    {
        $row = $this->store->find($declaration->clientId);
        if ($row === null) {
            $this->store->insert($declaration);
            return QaSystemClientSeedOutcome::Created;
        }

        if ($row['client_name'] !== QaSystemClientDeclaration::CLIENT_NAME) {
            throw new \DomainException('A client with the declared id exists under another name; refusing to take it over');
        }
        $grants = preg_split('/[\s|,]+/', $row['grant_types']) ?: [];
        if (in_array('authorization_code', $grants, true)) {
            throw new \DomainException('The client with the declared id allows authorization_code; refusing to take it over');
        }

        $storedJwks = null;
        if ($row['jwks'] !== null && $row['jwks'] !== '') {
            try {
                $storedJwks = QaSystemClientDeclaration::canonicalJwks($row['jwks']);
            } catch (\DomainException) {
                // An unreadable stored key set differs from any declared one.
                $storedJwks = null;
            }
        }

        $matches = $row['is_enabled']
            && $storedJwks === $declaration->jwks
            && $row['scope'] === $declaration->scope
            && $row['grant_types'] === self::GRANT_TYPES;
        if ($matches) {
            return QaSystemClientSeedOutcome::AlreadyConverged;
        }

        $this->store->converge($declaration);
        return QaSystemClientSeedOutcome::Converged;
    }
}
