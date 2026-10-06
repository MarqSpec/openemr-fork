<?php

/**
 * Isolated tests for the AgentForge QA system client seeder, for agent-forge's integration suite:
 * the declaration's parsing and refusals, and the seeder's
 * create / converge / leave-alone decision - above all that a second run
 * writes nothing, since the entrypoint runs it on every boot. Runs against an
 * in-memory OAuthClientStore, no database.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\AgentForge;

use OpenEMR\Modules\AgentForge\Seed\QaSystemClientDeclaration;
use OpenEMR\Modules\AgentForge\Seed\QaSystemClientSeeder;
use OpenEMR\Modules\AgentForge\Seed\QaSystemClientSeedOutcome;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class QaSystemClientSeederTest extends TestCase
{
    private const SEED_DIR = __DIR__ . '/../../../../../interface/modules/custom_modules/oe-module-agentforge/src/Seed/';

    private const CLIENT_ID = 'qa-system-client-id';
    private const PUBLIC_JWKS = '{"keys":[{"kty":"RSA","kid":"qa-key-1","alg":"RS384","use":"sig","n":"sXch","e":"AQAB"}]}';
    private const ROTATED_JWKS = '{"keys":[{"kty":"RSA","kid":"qa-key-2","alg":"RS384","use":"sig","n":"u2Zq","e":"AQAB"}]}';
    private const SCOPE = 'openid system/Patient.read system/Observation.read';

    // Literal, not the class constants: a data provider runs before setUpBeforeClass loads the class.
    private const ENV_ID = 'AGENTFORGE_QA_SYSTEM_CLIENT_ID';
    private const ENV_JWKS = 'AGENTFORGE_QA_SYSTEM_CLIENT_JWKS';
    private const ENV_SCOPE = 'AGENTFORGE_QA_SYSTEM_CLIENT_SCOPE';
    private const ENV_RAILWAY = 'RAILWAY_ENVIRONMENT_NAME';
    // Literal, not CLIENT_NAME: a renamed constant then turns the ownership cases red.
    private const QA_CLIENT_NAME = 'AgentForge QA System Client (integration tests)';

    private InMemoryOAuthClientStore $store;
    private QaSystemClientSeeder $seeder;

    public static function setUpBeforeClass(): void
    {
        // The module namespace is registered by the module bootstrap at runtime,
        // not by composer, so load the classes directly (as the other AgentForge
        // module tests do).
        foreach (['OAuthClientStore', 'QaSystemClientDeclaration', 'QaSystemClientSeedOutcome', 'QaSystemClientSeeder'] as $class) {
            require_once self::SEED_DIR . $class . '.php';
        }
        require_once __DIR__ . '/InMemoryOAuthClientStore.php';
    }

    protected function setUp(): void
    {
        $this->store = new InMemoryOAuthClientStore();
        $this->seeder = new QaSystemClientSeeder($this->store);
    }

    public function testNothingDeclaredMeansNoClient(): void
    {
        self::assertNull(QaSystemClientDeclaration::fromEnvironment([]));
        self::assertNull(QaSystemClientDeclaration::fromEnvironment([
            QaSystemClientDeclaration::ENV_CLIENT_ID => false,
            QaSystemClientDeclaration::ENV_JWKS => '',
            QaSystemClientDeclaration::ENV_SCOPE => '  ',
        ]));
    }

    public function testFirstRunOnAnEmptyDatabaseCreatesTheDeclaredClientEnabled(): void
    {
        $outcome = $this->seeder->seed($this->declaration());

        self::assertSame(QaSystemClientSeedOutcome::Created, $outcome);
        $row = $this->store->rows[self::CLIENT_ID];
        self::assertTrue($row['is_enabled']);
        self::assertSame(self::SCOPE, $row['scope']);
        self::assertSame('client_credentials', $row['grant_types']);
        self::assertSame(QaSystemClientDeclaration::canonicalJwks(self::PUBLIC_JWKS), $row['jwks']);
    }

    public function testSecondRunWritesNothing(): void
    {
        $this->seeder->seed($this->declaration());
        $writesAfterFirst = $this->store->writes;

        $outcome = $this->seeder->seed($this->declaration());

        self::assertSame(QaSystemClientSeedOutcome::AlreadyConverged, $outcome);
        self::assertSame($writesAfterFirst, $this->store->writes);
    }

    public function testSameKeysetInAnotherJsonLayoutIsAlreadyConverged(): void
    {
        $this->store->rows[self::CLIENT_ID] = [
            'client_name' => self::QA_CLIENT_NAME,
            'is_enabled' => true,
            'jwks' => '{ "keys" : [ {"kty":"RSA","kid":"qa-key-1","alg":"RS384","use":"sig","n":"sXch","e":"AQAB"} ] }',
            'scope' => self::SCOPE,
            'grant_types' => 'client_credentials',
        ];

        self::assertSame(QaSystemClientSeedOutcome::AlreadyConverged, $this->seeder->seed($this->declaration()));
        self::assertSame(0, $this->store->writes);
    }

    /**
     * @param array{client_name: string, is_enabled: bool, jwks: ?string, scope: string, grant_types: string} $drifted
     */
    #[DataProvider('driftedRows')]
    public function testADriftedClientIsRewrittenToTheDeclaration(array $drifted): void
    {
        $this->store->rows[self::CLIENT_ID] = $drifted;

        $outcome = $this->seeder->seed($this->declaration());

        self::assertSame(QaSystemClientSeedOutcome::Converged, $outcome);
        self::assertSame(1, $this->store->writes);
        $row = $this->store->rows[self::CLIENT_ID];
        self::assertTrue($row['is_enabled']);
        self::assertSame(QaSystemClientDeclaration::canonicalJwks(self::PUBLIC_JWKS), $row['jwks']);
        self::assertSame(self::SCOPE, $row['scope']);
        self::assertSame('client_credentials', $row['grant_types']);
    }

    /**
     * @return array<string, array{array{client_name: string, is_enabled: bool, jwks: ?string, scope: string, grant_types: string}}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function driftedRows(): array
    {
        $converged = [
            'client_name' => self::QA_CLIENT_NAME,
            'is_enabled' => true,
            'jwks' => self::PUBLIC_JWKS,
            'scope' => self::SCOPE,
            'grant_types' => 'client_credentials',
        ];

        return [
            'disabled, as a system-scope registration lands' => [array_replace($converged, ['is_enabled' => false])],
            'another key' => [array_replace($converged, ['jwks' => self::ROTATED_JWKS])],
            'no key at all' => [array_replace($converged, ['jwks' => null])],
            'an unreadable stored key' => [array_replace($converged, ['jwks' => 'not json'])],
            'another scope' => [array_replace($converged, ['scope' => 'openid system/Patient.read'])],
            'another grant' => [array_replace($converged, ['grant_types' => 'refresh_token'])],
        ];
    }

    public function testScopeIsCanonicalizedBeforeComparing(): void
    {
        $declaration = QaSystemClientDeclaration::fromEnvironment([
            QaSystemClientDeclaration::ENV_CLIENT_ID => self::CLIENT_ID,
            QaSystemClientDeclaration::ENV_JWKS => self::PUBLIC_JWKS,
            QaSystemClientDeclaration::ENV_SCOPE => "  openid   system/Patient.read\nsystem/Observation.read openid ",
        ]);

        self::assertNotNull($declaration);
        self::assertSame(self::SCOPE, $declaration->scope);
    }

    /**
     * @param array<string, string> $env
     */
    #[DataProvider('refusedDeclarations')]
    public function testMalformedOrPartialDeclarationsAreRefused(array $env, string $messageFragment): void
    {
        $this->expectException(\DomainException::class);
        $this->expectExceptionMessage($messageFragment);

        QaSystemClientDeclaration::fromEnvironment($env);
    }

    /**
     * @return array<string, array{array<string, string>, string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function refusedDeclarations(): array
    {
        $full = [
            self::ENV_ID => self::CLIENT_ID,
            self::ENV_JWKS => self::PUBLIC_JWKS,
            self::ENV_SCOPE => self::SCOPE,
        ];
        $privateKey = '{"keys":[{"kty":"RSA","n":"sXch","e":"AQAB","d":"not-a-real-exponent"}]}';

        return [
            'id missing' => [array_replace($full, [self::ENV_ID => '']), self::ENV_ID],
            'key missing' => [array_replace($full, [self::ENV_JWKS => '']), self::ENV_JWKS],
            'scope missing' => [array_replace($full, [self::ENV_SCOPE => '']), self::ENV_SCOPE],
            'key not JSON' => [array_replace($full, [self::ENV_JWKS => '{keys:']), 'not valid JSON'],
            'no keys array' => [array_replace($full, [self::ENV_JWKS => '{"kty":"RSA"}']), 'non-empty "keys"'],
            'empty keys array' => [array_replace($full, [self::ENV_JWKS => '{"keys":[]}']), 'non-empty "keys"'],
            'a private key' => [array_replace($full, [self::ENV_JWKS => $privateKey]), 'public keys only'],
            'a symmetric oct key' => [array_replace($full, [self::ENV_JWKS => '{"keys":[{"kty":"oct","k":"c2hhcmVkLXNlY3JldA"}]}']), 'public keys only'],
            'a k member on an RSA key' => [array_replace($full, [self::ENV_JWKS => '{"keys":[{"kty":"RSA","n":"sXch","e":"AQAB","k":"c2hhcmVk"}]}']), 'public keys only'],
            'an RSA prime' => [array_replace($full, [self::ENV_JWKS => '{"keys":[{"kty":"RSA","n":"sXch","e":"AQAB","p":"cHJpbWU"}]}']), 'public keys only'],
            'no kty' => [array_replace($full, [self::ENV_JWKS => '{"keys":[{"n":"sXch","e":"AQAB"}]}']), 'public keys only'],
            'declared in production' => [array_replace($full, [self::ENV_RAILWAY => 'production']), 'production'],
            'declared in Production, any case' => [array_replace($full, [self::ENV_RAILWAY => ' Production ']), 'production'],
            'no system scope' => [array_replace($full, [self::ENV_SCOPE => 'openid user/Patient.read']), 'system/'],
        ];
    }

    public function testNothingDeclaredInProductionIsStillNothingToDo(): void
    {
        self::assertNull(QaSystemClientDeclaration::fromEnvironment([self::ENV_RAILWAY => 'production']));
    }

    public function testStagingIsNotRefused(): void
    {
        $declaration = QaSystemClientDeclaration::fromEnvironment([
            self::ENV_ID => self::CLIENT_ID,
            self::ENV_JWKS => self::PUBLIC_JWKS,
            self::ENV_SCOPE => self::SCOPE,
            self::ENV_RAILWAY => 'staging',
        ]);

        self::assertNotNull($declaration);
    }

    public function testAnEcPublicKeyIsAccepted(): void
    {
        $ec = '{"keys":[{"kty":"EC","crv":"P-384","x":"eHg","y":"eXk","kid":"ec-1"}]}';

        self::assertStringContainsString('"kty":"EC"', QaSystemClientDeclaration::canonicalJwks($ec));
    }

    /**
     * @param array{client_name: string, is_enabled: bool, jwks: ?string, scope: string, grant_types: string} $foreign
     */
    #[DataProvider('foreignRows')]
    public function testARowThatIsNotTheQaClientIsRefusedNotRewritten(array $foreign, string $messageFragment): void
    {
        $this->store->rows[self::CLIENT_ID] = $foreign;

        try {
            $this->seeder->seed($this->declaration());
            self::fail('A foreign client with the declared id was taken over');
        } catch (\DomainException $e) {
            self::assertStringContainsString($messageFragment, $e->getMessage());
        }

        self::assertSame(0, $this->store->writes);
        self::assertSame($foreign, $this->store->rows[self::CLIENT_ID]);
    }

    /**
     * @return array<string, array{array{client_name: string, is_enabled: bool, jwks: ?string, scope: string, grant_types: string}, string}>
     *
     * @codeCoverageIgnore Data providers run before coverage instrumentation starts.
     */
    public static function foreignRows(): array
    {
        $smartClient = [
            'client_name' => 'AgentForge Copilot (patient launch)',
            'is_enabled' => true,
            'jwks' => null,
            'scope' => 'openid launch patient/Patient.read',
            'grant_types' => 'authorization_code|refresh_token',
        ];

        return [
            "the sidecar's SMART client, by a mistyped id" => [$smartClient, 'another name'],
            'another name, even with the QA grant' => [array_replace($smartClient, ['grant_types' => 'client_credentials']), 'another name'],
            'the QA name but authorization_code allowed' => [array_replace($smartClient, ['client_name' => self::QA_CLIENT_NAME]), 'authorization_code'],
            'the QA name, authorization_code among spaced grants' => [
                array_replace($smartClient, ['client_name' => self::QA_CLIENT_NAME, 'grant_types' => 'client_credentials authorization_code']),
                'authorization_code',
            ],
        ];
    }

    private function declaration(): QaSystemClientDeclaration
    {
        $declaration = QaSystemClientDeclaration::fromEnvironment([
            QaSystemClientDeclaration::ENV_CLIENT_ID => self::CLIENT_ID,
            QaSystemClientDeclaration::ENV_JWKS => self::PUBLIC_JWKS,
            QaSystemClientDeclaration::ENV_SCOPE => self::SCOPE,
        ]);
        self::assertNotNull($declaration);

        return $declaration;
    }
}
