<?php

/**
 * Persistence port for the QA system client seeder: one `oauth_clients` row,
 * found and written by its client_id.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Seed;

interface OAuthClientStore
{
    /**
     * The row's current state, or null when no client has this id.
     *
     * @return array{client_name: string, is_enabled: bool, jwks: ?string, scope: string, grant_types: string}|null
     */
    public function find(string $clientId): ?array;

    /** Inserts the declared client, enabled. */
    public function insert(QaSystemClientDeclaration $declaration): void;

    /** Overwrites the declared fields of an existing row and enables it. */
    public function converge(QaSystemClientDeclaration $declaration): void;
}
