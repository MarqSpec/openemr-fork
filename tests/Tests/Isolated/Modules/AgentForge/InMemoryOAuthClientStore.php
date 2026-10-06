<?php

/**
 * In-memory OAuthClientStore for the isolated QA system client seeder tests
 * for agent-forge's integration suite. Holds one row per client_id, shaped like what
 * QueryUtilsOAuthClientStore reads back, and counts writes so a test can
 * assert that a converged client is left alone.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\AgentForge;

use OpenEMR\Modules\AgentForge\Seed\OAuthClientStore;
use OpenEMR\Modules\AgentForge\Seed\QaSystemClientDeclaration;
use OpenEMR\Modules\AgentForge\Seed\QaSystemClientSeeder;

final class InMemoryOAuthClientStore implements OAuthClientStore
{
    /** @var array<string, array{client_name: string, is_enabled: bool, jwks: ?string, scope: string, grant_types: string}> */
    public array $rows = [];

    public int $writes = 0;

    public function find(string $clientId): ?array
    {
        return $this->rows[$clientId] ?? null;
    }

    public function insert(QaSystemClientDeclaration $declaration): void
    {
        $this->writes++;
        $this->rows[$declaration->clientId] = self::rowFor($declaration);
    }

    public function converge(QaSystemClientDeclaration $declaration): void
    {
        $this->writes++;
        $this->rows[$declaration->clientId] = self::rowFor($declaration);
    }

    /**
     * @return array{client_name: string, is_enabled: bool, jwks: ?string, scope: string, grant_types: string}
     */
    private static function rowFor(QaSystemClientDeclaration $declaration): array
    {
        return [
            'client_name' => QaSystemClientDeclaration::CLIENT_NAME,
            'is_enabled' => true,
            'jwks' => $declaration->jwks,
            'scope' => $declaration->scope,
            'grant_types' => QaSystemClientSeeder::GRANT_TYPES,
        ];
    }
}
