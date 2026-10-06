<?php

/**
 * DB-backed test for the AgentForge demo care-team seeder's QueryUtils store
 *: seeds a throwaway synthetic patient twice, asserts the second run
 * adds no rows, and reads the team back through CareTeamService — the service
 * FHIR `CareTeam?patient=` is built on — to prove the rows carry a Practitioner
 * and an Organization participant.
 *
 * Needs the dev stack's database (`openemr-cmd st` / services suite).
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Services\Modules\AgentForge;

use DateTimeImmutable;
use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Uuid\UuidRegistry;
use OpenEMR\Modules\AgentForge\Seed\CareTeamSeedOutcome;
use OpenEMR\Modules\AgentForge\Seed\DemoCareTeamMember;
use OpenEMR\Modules\AgentForge\Seed\DemoCareTeamSeeder;
use OpenEMR\Modules\AgentForge\Seed\QueryUtilsCareTeamStore;
use OpenEMR\Services\CareTeamService;
use PHPUnit\Framework\TestCase;

final class QueryUtilsCareTeamStoreTest extends TestCase
{
    private const SEED_DIR = __DIR__ . '/../../../../../interface/modules/custom_modules/oe-module-agentforge/src/Seed/';
    private const TEST_PUBPID = 'AF-TEST-CT-115';

    private int $pid = 0;
    private int $userId = 0;
    private int $facilityId = 0;

    public static function setUpBeforeClass(): void
    {
        foreach (['CareTeamSeedOutcome', 'CareTeamStore', 'DemoCareTeamMember', 'DemoCareTeamSeeder', 'QueryUtilsCareTeamStore'] as $class) {
            require_once self::SEED_DIR . $class . '.php';
        }
    }

    protected function setUp(): void
    {
        $this->removeTestPatient();

        $user = QueryUtils::querySingleRow("SELECT id FROM users WHERE username = 'admin'", []);
        $facility = QueryUtils::querySingleRow("SELECT id FROM facility ORDER BY id LIMIT 1", []);
        $this->userId = self::intColumn($user, 'id');
        $this->facilityId = self::intColumn($facility, 'id');
        if ($this->userId === 0 || $this->facilityId === 0) {
            self::markTestSkipped('The test database needs the admin user and at least one facility.');
        }

        $pid = self::intColumn(QueryUtils::querySingleRow("SELECT MAX(pid) + 1 AS pid FROM patient_data", []), 'pid');
        $this->pid = max(1, $pid);
        QueryUtils::sqlStatementThrowException(
            "INSERT INTO patient_data (pid, uuid, pubpid, fname, lname, DOB, sex) VALUES (?, ?, ?, 'Synthetic', 'Careteam', '1960-01-01', 'Female')",
            [$this->pid, UuidRegistry::getRegistryForTable('patient_data')->createUuid(), self::TEST_PUBPID]
        );
    }

    protected function tearDown(): void
    {
        $this->removeTestPatient();
    }

    public function testSeedingTwiceWritesOneTeamAndOneMember(): void
    {
        $seeder = new DemoCareTeamSeeder(new QueryUtilsCareTeamStore());
        $member = new DemoCareTeamMember($this->userId, $this->facilityId, 'specialist', new DateTimeImmutable('2026-03-29'), 'Synthetic demo data');

        self::assertSame(CareTeamSeedOutcome::TeamCreated, $seeder->seedPatient($this->pid, $member, $this->userId));
        self::assertSame(CareTeamSeedOutcome::AlreadySeeded, $seeder->seedPatient($this->pid, $member, $this->userId));

        self::assertSame(1, $this->countRows("SELECT COUNT(*) AS n FROM care_teams WHERE pid = ?"));
        self::assertSame(1, $this->countRows(
            "SELECT COUNT(*) AS n FROM care_team_member ctm JOIN care_teams ct ON ct.id = ctm.care_team_id WHERE ct.pid = ?"
        ));
    }

    public function testSeededTeamReadsBackWithPractitionerAndFacility(): void
    {
        $seeder = new DemoCareTeamSeeder(new QueryUtilsCareTeamStore());
        $seeder->seedPatient(
            $this->pid,
            new DemoCareTeamMember($this->userId, $this->facilityId, 'specialist', new DateTimeImmutable('2026-03-29'), 'Synthetic demo data'),
            $this->userId
        );

        $puuidRow = QueryUtils::querySingleRow("SELECT uuid FROM patient_data WHERE pid = ?", [$this->pid]);
        self::assertIsArray($puuidRow);
        self::assertIsString($puuidRow['uuid']);
        $result = (new CareTeamService())->getAll([], true, UuidRegistry::uuidToString($puuidRow['uuid']));

        $teams = $result->getData();
        self::assertIsArray($teams);
        self::assertCount(1, $teams);
        self::assertIsArray($teams[0]);
        self::assertSame(DemoCareTeamSeeder::TEAM_NAME, $teams[0]['team_name']);
        self::assertSame('active', $teams[0]['care_team_status']);
        self::assertIsArray($teams[0]['providers']);
        self::assertCount(1, $teams[0]['providers'], 'one Practitioner participant');
        self::assertIsArray($teams[0]['facilities']);
        self::assertCount(1, $teams[0]['facilities'], 'one Organization participant');
    }

    private function countRows(string $sql): int
    {
        return self::intColumn(QueryUtils::querySingleRow($sql, [$this->pid]), 'n');
    }

    private function removeTestPatient(): void
    {
        $row = QueryUtils::querySingleRow("SELECT pid FROM patient_data WHERE pubpid = ?", [self::TEST_PUBPID]);
        $pid = self::intColumn($row, 'pid');
        if ($pid === 0) {
            return;
        }
        QueryUtils::sqlStatementThrowException(
            "DELETE ctm FROM care_team_member ctm JOIN care_teams ct ON ct.id = ctm.care_team_id WHERE ct.pid = ?",
            [$pid]
        );
        QueryUtils::sqlStatementThrowException("DELETE FROM care_teams WHERE pid = ?", [$pid]);
        QueryUtils::sqlStatementThrowException("DELETE FROM patient_data WHERE pid = ?", [$pid]);
    }

    private static function intColumn(mixed $row, string $key): int
    {
        if (!is_array($row) || !isset($row[$key])) {
            return 0;
        }
        $value = $row[$key];
        if (is_int($value)) {
            return $value;
        }

        return is_string($value) && ctype_digit($value) ? (int) $value : 0;
    }
}
