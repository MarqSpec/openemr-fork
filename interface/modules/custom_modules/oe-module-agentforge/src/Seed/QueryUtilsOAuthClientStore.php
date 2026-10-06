<?php

/**
 * OAuthClientStore over the `oauth_clients` table. The insert writes the same
 * columns ClientRepository::insertNewClient() writes for a private
 * (confidential, `client_role` user) dynamic registration, so the row is
 * indistinguishable from a registered one - except that its id is the declared
 * one and it is enabled. It is written here rather than through
 * insertNewClient() because that method reads the web session's authUserID and
 * chooses is_enabled itself, and this runs from the container entrypoint.
 *
 * The client secret is random and never leaves this process: a
 * client_credentials grant on this server authenticates by the JWT assertion
 * alone, and the column is kept non-empty only so the row reads as the
 * confidential client it is.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Seed;

use OpenEMR\Common\Auth\OpenIDConnect\Repositories\ClientRepository;
use OpenEMR\Common\Database\QueryUtils;

final readonly class QueryUtilsOAuthClientStore implements OAuthClientStore
{
    /** Required by the registration contract; a client_credentials client never redirects. */
    private const REDIRECT_URI = 'https://qa-system-client.invalid/unused';

    public function __construct(private string $siteId = 'default')
    {
    }

    public function find(string $clientId): ?array
    {
        $row = QueryUtils::querySingleRow(
            "SELECT client_name, is_enabled, jwks, scope, grant_types FROM oauth_clients WHERE client_id = ?",
            [$clientId]
        );
        if (!is_array($row)) {
            return null;
        }

        return [
            'client_name' => self::stringColumn($row, 'client_name'),
            'is_enabled' => self::stringColumn($row, 'is_enabled') === '1',
            'jwks' => isset($row['jwks']) && is_string($row['jwks']) ? $row['jwks'] : null,
            'scope' => self::stringColumn($row, 'scope'),
            'grant_types' => self::stringColumn($row, 'grant_types'),
        ];
    }

    public function insert(QaSystemClientDeclaration $declaration): void
    {
        $repository = new ClientRepository();
        $secret = $repository->getCryptoGen()->encryptForDatabase(bin2hex(random_bytes(64)));

        QueryUtils::sqlStatementThrowException(
            "INSERT INTO oauth_clients (client_id, client_role, client_name, client_secret, registration_token,
                registration_uri_path, register_date, redirect_uri, grant_types, scope, site_id, is_confidential,
                jwks, is_enabled, skip_ehr_launch_authorization_flow, dsi_type)
             VALUES (?, 'user', ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 1, ?, 1, 0, 0)",
            [
                $declaration->clientId,
                QaSystemClientDeclaration::CLIENT_NAME,
                $secret,
                $repository->generateRegistrationAccessToken(),
                $repository->generateRegistrationClientUriPath(),
                self::REDIRECT_URI,
                QaSystemClientSeeder::GRANT_TYPES,
                $declaration->scope,
                $this->siteId,
                $declaration->jwks,
            ]
        );
    }

    public function converge(QaSystemClientDeclaration $declaration): void
    {
        QueryUtils::sqlStatementThrowException(
            "UPDATE oauth_clients SET jwks = ?, scope = ?, grant_types = ?, is_enabled = 1, revoke_date = NULL
             WHERE client_id = ?",
            [$declaration->jwks, $declaration->scope, QaSystemClientSeeder::GRANT_TYPES, $declaration->clientId]
        );
    }

    /**
     * @param array<mixed> $row
     */
    private static function stringColumn(array $row, string $key): string
    {
        return isset($row[$key]) && is_scalar($row[$key]) ? (string) $row[$key] : '';
    }
}
