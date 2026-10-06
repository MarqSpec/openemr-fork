<?php

/**
 * Isolated tests for the AgentForge demo care-team seeder: the seeding
 * rules and, above all, idempotency — a second run over the same cohort must not
 * add a team or a member. Runs against an in-memory CareTeamStore, no database.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Tests\Isolated\Modules\AgentForge;

use DateTimeImmutable;
use OpenEMR\Modules\AgentForge\Seed\CareTeamSeedOutcome;
use OpenEMR\Modules\AgentForge\Seed\DemoCareTeamMember;
use OpenEMR\Modules\AgentForge\Seed\DemoCareTeamSeeder;
use PHPUnit\Framework\TestCase;

final class DemoCareTeamSeederTest extends TestCase
{
    private const SEED_DIR = __DIR__ . '/../../../../../interface/modules/custom_modules/oe-module-agentforge/src/Seed/';

    private InMemoryCareTeamStore $store;
    private DemoCareTeamSeeder $seeder;

    public static function setUpBeforeClass(): void
    {
        // The module namespace is registered by the module bootstrap at runtime,
        // not by composer, so load the classes directly (as the other AgentForge
        // module tests do).
        foreach (['CareTeamSeedOutcome', 'CareTeamStore', 'DemoCareTeamMember', 'DemoCareTeamSeeder'] as $class) {
            require_once self::SEED_DIR . $class . '.php';
        }
        require_once __DIR__ . '/InMemoryCareTeamStore.php';
    }

    protected function setUp(): void
    {
        $this->store = new InMemoryCareTeamStore();
        $this->seeder = new DemoCareTeamSeeder($this->store);
    }

    public function testFirstRunCreatesTeamWithPractitionerAndFacility(): void
    {
        $outcome = $this->seeder->seedPatient(101, $this->cardiologist(), 7);

        self::assertSame(CareTeamSeedOutcome::TeamCreated, $outcome);
        self::assertCount(1, $this->store->teams);
        $team = $this->store->teams[0];
        self::assertSame(101, $team['pid']);
        self::assertSame(DemoCareTeamSeeder::TEAM_NAME, $team['team_name']);
        self::assertSame(7, $team['created_by']);

        self::assertCount(1, $this->store->members);
        $member = $this->store->members[0];
        self::assertSame($team['id'], $member['care_team_id']);
        self::assertSame(7, $member['user_id'], 'the practitioner is a users.id');
        self::assertSame(3, $member['facility_id'], 'the facility rides on the same member row');
        self::assertSame('specialist', $member['role']);
        self::assertSame('2026-03-29', $member['provider_since']);
    }

    public function testSecondRunIsIdempotent(): void
    {
        $this->seeder->seedPatient(101, $this->cardiologist(), 7);
        $teamsAfterFirst = $this->store->teams;
        $membersAfterFirst = $this->store->members;

        $outcome = $this->seeder->seedPatient(101, $this->cardiologist(), 7);

        self::assertSame(CareTeamSeedOutcome::AlreadySeeded, $outcome);
        self::assertSame($teamsAfterFirst, $this->store->teams, 'no duplicate team');
        self::assertSame($membersAfterFirst, $this->store->members, 'no duplicate member');
    }

    public function testRerunOverWholeCohortAddsNothing(): void
    {
        $cohort = [101, 102, 103, 104, 105, 106, 107];
        foreach ($cohort as $pid) {
            $this->seeder->seedPatient($pid, $this->cardiologist(), 7);
        }
        self::assertCount(7, $this->store->teams);
        self::assertCount(7, $this->store->members);

        foreach ($cohort as $pid) {
            self::assertSame(
                CareTeamSeedOutcome::AlreadySeeded,
                $this->seeder->seedPatient($pid, $this->cardiologist(), 7)
            );
        }
        self::assertCount(7, $this->store->teams);
        self::assertCount(7, $this->store->members);
    }

    public function testExistingDemoTeamWithoutMemberGetsOnlyTheMember(): void
    {
        // A half-finished earlier run: the team exists but its member insert did not land.
        $teamId = $this->store->createCareTeam(101, DemoCareTeamSeeder::TEAM_NAME, 7);

        $outcome = $this->seeder->seedPatient(101, $this->cardiologist(), 7);

        self::assertSame(CareTeamSeedOutcome::MemberAdded, $outcome);
        self::assertCount(1, $this->store->teams);
        self::assertCount(1, $this->store->members);
        self::assertSame($teamId, $this->store->members[0]['care_team_id']);
    }

    public function testAnotherTeamOnThePatientIsLeftAlone(): void
    {
        // A team a user built by hand is not the demo team and is never modified.
        $this->store->createCareTeam(101, 'Primary care', 1);

        $outcome = $this->seeder->seedPatient(101, $this->cardiologist(), 7);

        self::assertSame(CareTeamSeedOutcome::TeamCreated, $outcome);
        self::assertCount(2, $this->store->teams);
        self::assertSame('Primary care', $this->store->teams[0]['team_name']);
        self::assertCount(1, $this->store->members);
        self::assertSame($this->store->teams[1]['id'], $this->store->members[0]['care_team_id']);
    }

    public function testMemberWithoutSinceDateIsStoredWithNullSince(): void
    {
        $member = new DemoCareTeamMember(7, 3, 'specialist', null, 'Synthetic demo data');

        $this->seeder->seedPatient(101, $member, 7);

        self::assertNull($this->store->members[0]['provider_since']);
    }

    public function testMemberRejectsNonPositivePractitionerId(): void
    {
        $this->expectException(\DomainException::class);
        new DemoCareTeamMember(0, 3, 'specialist', null, '');
    }

    public function testMemberRejectsNonPositiveFacilityId(): void
    {
        $this->expectException(\DomainException::class);
        new DemoCareTeamMember(7, 0, 'specialist', null, '');
    }

    public function testMemberRejectsBlankRole(): void
    {
        $this->expectException(\DomainException::class);
        new DemoCareTeamMember(7, 3, '  ', null, '');
    }

    public function testSeedRejectsNonPositivePatientId(): void
    {
        $this->expectException(\DomainException::class);
        $this->seeder->seedPatient(0, $this->cardiologist(), 7);
    }

    private function cardiologist(): DemoCareTeamMember
    {
        return new DemoCareTeamMember(
            7,
            3,
            'specialist',
            new DateTimeImmutable('2026-03-29'),
            'Synthetic demo data'
        );
    }
}
