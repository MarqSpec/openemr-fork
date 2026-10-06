<?php

/**
 * Give every EXISTING synthetic AgentForge demo patient (AF-DEMO-*) a care team,
 * so the Care Team card and FHIR `CareTeam?patient=` have data (BUG-30).
 * Companion to seed_cardiology_demo.php, which creates the cohort and now seeds
 * the same team for a fresh cohort; run this one to backfill a cohort seeded
 * before care teams existed. It never creates patients or touches charts.
 *
 * Each patient gets one team, "AgentForge Demo Cardiology Team" (status active),
 * with one member: the cardiologist (users.id, role `specialist`) acting for the
 * clinic (facility.id). That one `care_team_member` row gives the FHIR CareTeam a
 * Practitioner participant (onBehalfOf the Organization) and an Organization
 * participant. "Since" is the patient's first encounter date, when there is one.
 *
 * Idempotent: the team is keyed on (patient, team name) and the member on
 * (team, practitioner, facility) — a re-run writes nothing, and a run cut short
 * is completed rather than duplicated. Other care teams on a patient are left
 * alone.
 *
 * SYNTHETIC / DEMO DATA ONLY — never real PHI (repo rule).
 *
 * Writes `care_teams` / `care_team_member`, the tables CareTeamService (and so
 * FhirCareTeamService) reads. See BUG-30 and Q-10.
 *
 * Usage (inside the OpenEMR container, as the web user - NOT root):
 *   su -s /bin/sh apache -c 'php \
 *     interface/modules/custom_modules/oe-module-agentforge/scripts/seed_demo_care_teams.php \
 *     [--provider=<username>]'
 *   optional: --dry-run     # print what would be seeded, write nothing
 *
 * The provider is auto-derived from the cohort's existing appointments, as
 * seed_demo_appointments.php does; pass --provider=<username> to override.
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

// globals.php is a web entry point: give it a site (and host) so it does not
// reject the run as siteless. Run as the web user, not root (RootCliGuard).
// @phpstan-ignore openemr.forbiddenRequestGlobals
$_GET['site'] = 'default';
// @phpstan-ignore openemr.forbiddenRequestGlobals
$_SERVER['HTTP_HOST'] = 'localhost';
$ignoreAuth = true;
$sessionAllowWrite = true;
require_once __DIR__ . "/../../../../globals.php";

// The module namespace is only registered when the module is enabled; load the
// seeder directly so the script works either way.
foreach (['CareTeamSeedOutcome', 'CareTeamStore', 'DemoCareTeamMember', 'DemoCareTeamSeeder', 'QueryUtilsCareTeamStore'] as $afSeedClass) {
    require_once __DIR__ . '/../src/Seed/' . $afSeedClass . '.php';
}

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Session\SessionUtil;
use OpenEMR\Modules\AgentForge\Seed\CareTeamSeedOutcome;
use OpenEMR\Modules\AgentForge\Seed\DemoCareTeamMember;
use OpenEMR\Modules\AgentForge\Seed\DemoCareTeamSeeder;
use OpenEMR\Modules\AgentForge\Seed\QueryUtilsCareTeamStore;

// DB rows are `mixed` to static analysis; narrow a single-row result by key,
// staying inside the fork's strict ruleset (closures: no global functions).
$afRowInt = (static fn(mixed $row, string $key): int => (is_array($row) && isset($row[$key]) && is_scalar($row[$key])) ? (int) $row[$key] : 0);
$afRowStr = (static fn(mixed $row, string $key): string => (is_array($row) && isset($row[$key]) && is_scalar($row[$key])) ? (string) $row[$key] : '');

$options = getopt('', ['provider::', 'dry-run']);
$dryRun = array_key_exists('dry-run', $options);
$providerOpt = (isset($options['provider']) && is_string($options['provider']) && $options['provider'] !== '') ? $options['provider'] : null;

$cohort = QueryUtils::fetchRecords(
    "SELECT pid, pubpid, fname, lname FROM patient_data WHERE pubpid LIKE 'AF-DEMO-%' ORDER BY pubpid",
    []
);
if (count($cohort) === 0) {
    fwrite(STDERR, "No AF-DEMO-* patients found. Run seed_cardiology_demo.php first.\n");
    exit(1);
}

// Provider: explicit --provider wins; otherwise the cohort's most recent
// appointment provider (the cardiologist the Daily Agenda filters on).
if ($providerOpt !== null) {
    $providerId = $afRowInt(
        QueryUtils::querySingleRow("SELECT id FROM users WHERE username = ? AND active = 1", [$providerOpt]),
        'id'
    );
    $providerLabel = $providerOpt;
    if ($providerId === 0) {
        fwrite(STDERR, "Provider user '$providerOpt' not found or inactive.\n");
        exit(1);
    }
} else {
    $derived = QueryUtils::querySingleRow(
        "SELECT e.pc_aid, u.username
           FROM openemr_postcalendar_events e
           JOIN patient_data pd ON pd.pid = e.pc_pid
           LEFT JOIN users u ON u.id = e.pc_aid
          WHERE pd.pubpid LIKE 'AF-DEMO-%' AND e.pc_aid > 0
          ORDER BY e.pc_eventDate DESC, e.pc_startTime DESC
          LIMIT 1",
        []
    );
    $providerId = $afRowInt($derived, 'pc_aid');
    $providerLabel = $afRowStr($derived, 'username') ?: '(derived)';
    if ($providerId === 0) {
        fwrite(STDERR, "Could not derive a provider from existing AF-DEMO appointments. Pass --provider=<username>.\n");
        exit(1);
    }
}

$facilityId = $afRowInt(QueryUtils::querySingleRow("SELECT id FROM facility ORDER BY id LIMIT 1"), 'id');
if ($facilityId === 0) {
    fwrite(STDERR, "No facility found. Create one in Admin -> Facilities first.\n");
    exit(1);
}

// Attribute the writes to the provider (same reason the other seeders do).
SessionUtil::setSession('authUserID', $providerId);

$seeder = new DemoCareTeamSeeder(new QueryUtilsCareTeamStore());
$tally = ['created' => 0, 'member' => 0, 'present' => 0];

foreach ($cohort as $patient) {
    $pid = $afRowInt($patient, 'pid');
    $label = sprintf('%s — %s %s (pid %d)', $afRowStr($patient, 'pubpid'), $afRowStr($patient, 'fname'), $afRowStr($patient, 'lname'), $pid);
    if ($pid === 0) {
        continue;
    }

    $firstVisit = $afRowStr(QueryUtils::querySingleRow("SELECT MIN(date) AS first_visit FROM form_encounter WHERE pid = ?", [$pid]), 'first_visit');
    $since = $firstVisit !== '' ? DateTimeImmutable::createFromFormat('!Y-m-d', substr($firstVisit, 0, 10)) : false;

    if ($dryRun) {
        echo "would ensure care team for $label · provider $providerLabel @ facility $facilityId\n";
        continue;
    }

    $member = new DemoCareTeamMember(
        $providerId,
        $facilityId,
        'specialist',
        $since === false ? null : $since,
        'Synthetic demo data (AgentForge demo cohort)'
    );
    $outcome = $seeder->seedPatient($pid, $member, $providerId);
    match ($outcome) {
        CareTeamSeedOutcome::TeamCreated => $tally['created']++,
        CareTeamSeedOutcome::MemberAdded => $tally['member']++,
        CareTeamSeedOutcome::AlreadySeeded => $tally['present']++,
    };
    echo match ($outcome) {
        CareTeamSeedOutcome::TeamCreated => "team  $label\n",
        CareTeamSeedOutcome::MemberAdded => "member $label (team existed)\n",
        CareTeamSeedOutcome::AlreadySeeded => "exist $label\n",
    };
}

echo "\nDone. teams created={$tally['created']} members added={$tally['member']} already seeded={$tally['present']} provider=$providerLabel (users.id $providerId) facility=$facilityId\n";
exit(0);
