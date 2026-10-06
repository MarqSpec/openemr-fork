<?php

/**
 * The QA system client an environment declares, read from its environment
 * for agent-forge's integration suite. A confidential `client_credentials` client whose only
 * credential is the PUBLIC key in its JWKS: the integration suite signs a
 * JWT-bearer assertion (RFC 7523) with the matching private key, so nothing
 * here is secret and nothing here is generated. That is the point - a client
 * whose id and key are declared survives a reseed with the same id, where a
 * dynamically registered one comes back with a new random id every time.
 *
 * All three variables unset means "no QA client here" (production, local
 * compose). Any other partial or malformed declaration is refused rather than
 * half-applied.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Seed;

final readonly class QaSystemClientDeclaration
{
    public const ENV_CLIENT_ID = 'AGENTFORGE_QA_SYSTEM_CLIENT_ID';
    public const ENV_JWKS = 'AGENTFORGE_QA_SYSTEM_CLIENT_JWKS';
    public const ENV_SCOPE = 'AGENTFORGE_QA_SYSTEM_CLIENT_SCOPE';

    /** Set by Railway on every service; a declaration here is refused whatever it says. */
    public const ENV_RAILWAY_ENVIRONMENT = 'RAILWAY_ENVIRONMENT_NAME';
    public const REFUSED_ENVIRONMENT = 'production';

    /** Asymmetric key types only: a symmetric (`oct`) key IS the signing secret. */
    private const PUBLIC_KEY_TYPES = ['RSA', 'EC'];
    /** JWK members that carry private or symmetric key material (RFC 7518 §6). */
    private const SECRET_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

    public const CLIENT_NAME = 'AgentForge QA System Client (integration tests)';

    /**
     * @param string $jwks canonical JSON of the key set, as stored in oauth_clients.jwks
     */
    private function __construct(
        public string $clientId,
        public string $jwks,
        public string $scope,
    ) {
    }

    /**
     * @param array<string, string|false> $env variable name => value (false or '' when unset)
     * @return self|null null when none of the three variables is set
     * @throws \DomainException when the declaration is partial or malformed, or made in production
     */
    public static function fromEnvironment(array $env): ?self
    {
        $clientId = trim((string) ($env[self::ENV_CLIENT_ID] ?? ''));
        $jwksRaw = trim((string) ($env[self::ENV_JWKS] ?? ''));
        $scopeRaw = trim((string) ($env[self::ENV_SCOPE] ?? ''));

        if ($clientId === '' && $jwksRaw === '' && $scopeRaw === '') {
            return null;
        }

        // A duplicated Railway environment copies service variables, so their absence is not a
        // guarantee: a system/ client keyed to a CI-held private key never runs in production.
        $environment = strtolower(trim((string) ($env[self::ENV_RAILWAY_ENVIRONMENT] ?? '')));
        if ($environment === self::REFUSED_ENVIRONMENT) {
            throw new \DomainException('QA system client declared in the ' . self::REFUSED_ENVIRONMENT
                . ' environment (' . self::ENV_RAILWAY_ENVIRONMENT . '); refusing');
        }

        $missing = [];
        foreach ([self::ENV_CLIENT_ID => $clientId, self::ENV_JWKS => $jwksRaw, self::ENV_SCOPE => $scopeRaw] as $name => $value) {
            if ($value === '') {
                $missing[] = $name;
            }
        }
        if ($missing !== []) {
            throw new \DomainException('Partial QA system client declaration; unset: ' . implode(', ', $missing));
        }

        return new self($clientId, self::canonicalJwks($jwksRaw), self::canonicalScope($scopeRaw));
    }

    /** Normalizes a stored or declared key set so the two compare equal when they carry the same keys. */
    public static function canonicalJwks(string $jwks): string
    {
        try {
            $decoded = json_decode($jwks, true, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new \DomainException(self::ENV_JWKS . ' is not valid JSON');
        }
        if (!is_array($decoded) || !isset($decoded['keys']) || !is_array($decoded['keys']) || $decoded['keys'] === []) {
            throw new \DomainException(self::ENV_JWKS . ' must be a JWKS object with a non-empty "keys" array');
        }
        foreach ($decoded['keys'] as $key) {
            // A private or symmetric member would publish the key the suite signs with.
            if (
                !is_array($key)
                || !in_array($key['kty'] ?? null, self::PUBLIC_KEY_TYPES, true)
                || array_intersect(self::SECRET_MEMBERS, array_keys($key)) !== []
            ) {
                throw new \DomainException(self::ENV_JWKS . ' must hold public keys only (kty RSA or EC, no private or symmetric members)');
            }
        }

        return json_encode($decoded, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    }

    /** Space-separated, de-duplicated, order preserved. Requires at least one system/ scope. */
    public static function canonicalScope(string $scope): string
    {
        $parts = array_values(array_unique(array_filter(
            preg_split('/\s+/', trim($scope)) ?: [],
            static fn(string $s): bool => $s !== ''
        )));
        $hasSystem = array_filter($parts, static fn(string $s): bool => str_starts_with($s, 'system/'));
        if ($hasSystem === []) {
            throw new \DomainException(self::ENV_SCOPE . ' must request at least one system/ scope');
        }

        return implode(' ', $parts);
    }
}
