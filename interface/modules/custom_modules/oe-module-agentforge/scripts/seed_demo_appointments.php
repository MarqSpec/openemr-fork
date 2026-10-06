<?php

/**
 * Book upcoming appointments for the EXISTING synthetic AgentForge demo cohort
 * (AF-DEMO-01..07) so the Daily Agenda has a multi-day roster — a full clinic
 * each day across the next few days. Companion to seed_cardiology_demo.php:
 * that script creates the patients/charts + a single same-day appointment; this
 * one only adds appointments to patients that already exist. It never touches
 * charts and never creates patients.
 *
 * Idempotent: keyed on (patient, provider, date) — a patient who already has an
 * appointment with the provider on a given day is skipped, so a re-run tops up
 * missing days rather than stacking duplicates.
 *
 * The provider is auto-derived from the cohort's existing appointments (the
 * pc_aid the Daily Agenda already filters on); pass --provider=<username> to
 * override or to seed onto a fresh cohort that has no appointment yet.
 *
 * SYNTHETIC / DEMO DATA ONLY — never real PHI (repo rule).
 *
 * Writes to openemr_postcalendar_events via AppointmentService, pc_aid = the
 * provider's users.id (what the Daily Agenda filters on), as the AgentForge
 * copilot's interface control document expects (Schedule / UC-6).
 *
 * Usage (inside the OpenEMR container, as the web user - NOT root):
 *   su -s /bin/sh apache -c 'php \
 *     interface/modules/custom_modules/oe-module-agentforge/scripts/seed_demo_appointments.php \
 *     [--provider=<username>] [--days=3] [--start-hour=9]'
 *   optional: --dry-run     # print what would be booked, write nothing
 *   optional: --weekdays    # skip Sat/Sun when spreading across days
 *   optional: --end-hour=N  # spread the day's appointments from --start-hour
 *                           # until they END at N, instead of running them
 *                           # back-to-back from --start-hour
 *   optional: --per-day=N   # book N of the cohort each day instead of all of
 *                           # them, rotating so everyone appears over the window
 *
 * Why --end-hour matters for the agenda: the Daily Agenda lists only
 * appointments still in the future on the current date, so a back-to-back
 * morning block leaves it empty for the rest of the clinic day. Spreading the
 * same appointments across the day keeps a roster on screen into the afternoon.
 * The calendar is unaffected either way - it draws whatever is booked.
 *
 * For a demo instance that should stay populated, a full quarter at six a day
 * across the clinic day:
 *   ... --provider=dr_cardio --days=90 --per-day=6 --start-hour=8 --end-hour=16
 *
 * @package   OpenEMR
 * @author    AgentForge
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
// Resolve globals absolutely so the script runs from /tmp too; fall back to the
// module-relative path when dropped into scripts/ (baked into the image).
$afGlobals = '/var/www/localhost/htdocs/openemr/interface/globals.php';
require_once is_file($afGlobals) ? $afGlobals : __DIR__ . "/../../../../globals.php";

use OpenEMR\Common\Database\QueryUtils;
use OpenEMR\Common\Session\SessionUtil;
use OpenEMR\Services\AppointmentService;

/** Length of one demo appointment, in minutes. Also the slot spacing. */
const APPT_DURATION_MIN = 30;

// DB rows are `mixed` to static analysis; narrow a single-row result to int by
// key (0 when absent/non-scalar), staying inside the fork's strict ruleset.
$afRowInt = (static fn(mixed $row, string $key): int => (is_array($row) && isset($row[$key]) && is_scalar($row[$key])) ? (int) $row[$key] : 0);
// Same narrowing for string columns (pubpid/fname/lname): DB rows are `mixed`, and sprintf's %s
// args must be scalar under the fork's strict ruleset.
$afRowStr = (static fn(mixed $row, string $key): string => (is_array($row) && isset($row[$key]) && is_scalar($row[$key])) ? (string) $row[$key] : '');

$options = getopt('', ['provider::', 'days::', 'start-hour::', 'end-hour::', 'per-day::', 'dry-run', 'weekdays']);
$dryRun = array_key_exists('dry-run', $options);
$weekdaysOnly = array_key_exists('weekdays', $options);
$days = (isset($options['days']) && is_numeric($options['days'])) ? max(1, (int) $options['days']) : 3;
$startHour = (isset($options['start-hour']) && is_numeric($options['start-hour'])) ? (int) $options['start-hour'] : 9;
$endHour = (isset($options['end-hour']) && is_numeric($options['end-hour'])) ? (int) $options['end-hour'] : null;
$perDayOpt = (isset($options['per-day']) && is_numeric($options['per-day'])) ? max(1, (int) $options['per-day']) : null;
$providerOpt = (isset($options['provider']) && is_string($options['provider']) && $options['provider'] !== '') ? $options['provider'] : null;

if ($endHour !== null && $endHour <= $startHour) {
    fwrite(STDERR, "--end-hour ($endHour) must be later than --start-hour ($startHour).\n");
    exit(1);
}

// Resolve the cohort: existing AF-DEMO patients, in pubpid order.
$cohort = QueryUtils::fetchRecords(
    "SELECT pid, pubpid, fname, lname FROM patient_data WHERE pubpid LIKE 'AF-DEMO-%' ORDER BY pubpid",
    []
);
if (count($cohort) === 0) {
    fwrite(STDERR, "No AF-DEMO-* patients found. Run seed_cardiology_demo.php first.\n");
    exit(1);
}

// Provider: explicit --provider wins; otherwise derive from the cohort's most
// recent existing appointment (the pc_aid the agenda already filters on).
if ($providerOpt !== null) {
    $providerRow = QueryUtils::querySingleRow(
        "SELECT id, username FROM users WHERE username = ? AND active = 1",
        [$providerOpt]
    );
    $providerId = $afRowInt($providerRow, 'id');
    $providerUsername = $providerOpt;
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
    $providerUsername = (is_array($derived) && isset($derived['username']) && is_string($derived['username'])) ? $derived['username'] : '(derived)';
    if ($providerId === 0) {
        fwrite(STDERR, "Could not derive a provider from existing AF-DEMO appointments. Pass --provider=<username>.\n");
        exit(1);
    }
}

// Attribute the writes to the provider (same reason seed_cardiology_demo does).
SessionUtil::setSession('authUserID', $providerId);

$facilityRow = QueryUtils::querySingleRow("SELECT id FROM facility ORDER BY id LIMIT 1");
$facilityId = $afRowInt($facilityRow, 'id') ?: 3;

$catRow = QueryUtils::querySingleRow("SELECT pc_catid FROM openemr_postcalendar_categories WHERE pc_catname LIKE 'Office Visit' LIMIT 1");
$officeVisitCatId = $afRowInt($catRow, 'pc_catid') ?: 5;

// Build the list of target dates (skip today; start tomorrow), optionally
// skipping weekends, until we have $days clinic days.
$dates = [];
$offset = 1;
while (count($dates) < $days) {
    $ts = strtotime("+$offset days");
    $offset++;
    if ($ts === false) {
        continue; // controlled input; guard keeps $dates a list<int> for date() below
    }
    if ($weekdaysOnly) {
        $dow = (int) date('N', $ts); // 6=Sat, 7=Sun
        if ($dow >= 6) {
            continue;
        }
    }
    $dates[] = $ts;
}

$appointmentService = new AppointmentService();
$booked = 0;
$skipped = 0;

// How many of the cohort to book per day, and where their slots fall.
$perDay = min($perDayOpt ?? count($cohort), count($cohort));

// Minute offsets from $startHour, one per appointment. Default: back-to-back
// 30-minute slots, the original "one full clinic, first thing" shape. With
// --end-hour the same appointments spread evenly across the clinic day, so the
// Daily Agenda - which lists only appointments still in the future - keeps a
// roster into the afternoon instead of emptying once the morning block passes.
$offsets = [];
if ($endHour === null || $perDay === 1) {
    for ($i = 0; $i < $perDay; $i++) {
        $offsets[] = $i * APPT_DURATION_MIN;
    }
} else {
    // Last appointment ENDS at --end-hour, so the last start is one slot before it.
    $lastOffset = ($endHour - $startHour) * 60 - APPT_DURATION_MIN;
    if ($lastOffset < 0) {
        fwrite(STDERR, "--start-hour to --end-hour is shorter than one " . APPT_DURATION_MIN . "-minute appointment.\n");
        exit(1);
    }
    for ($i = 0; $i < $perDay; $i++) {
        // Round to 5 minutes so the calendar grid shows tidy times.
        $offsets[] = (int) (round(($lastOffset * $i / ($perDay - 1)) / 5) * 5);
    }
    // A window too narrow for $perDay would space slots closer together than an
    // appointment is long, double-booking the provider against themselves.
    for ($i = 1; $i < count($offsets); $i++) {
        if (($offsets[$i] - $offsets[$i - 1]) < APPT_DURATION_MIN) {
            fwrite(STDERR, "--per-day $perDay does not fit between $startHour:00 and $endHour:00 at "
                . APPT_DURATION_MIN . " minutes each without overlapping.\n");
            exit(1);
        }
    }
}

echo "provider=$providerUsername (users.id $providerId) · cohort=" . count($cohort)
    . " · days=$days · per-day=$perDay · start-hour=$startHour"
    . ($endHour !== null ? " · end-hour=$endHour" : "")
    . ($weekdaysOnly ? " · weekdays-only" : "")
    . ($dryRun ? " · DRY-RUN" : "") . "\n\n";

$dayIndex = 0; // explicit int counter; foreach keys type as int|string under phpstan
foreach ($dates as $ts) {
    $date = date('Y-m-d', $ts);
    echo "== $date (" . date('D', $ts) . ") ==\n";

    for ($slot = 0; $slot < $perDay; $slot++) {
        // Rotate which of the cohort gets booked when --per-day is smaller than
        // it, so every patient appears across the window instead of the tail of
        // the list never being seen.
        $p = $cohort[($dayIndex * $perDay + $slot) % count($cohort)];
        $pid = $afRowInt($p, 'pid');
        $pubpid = $afRowStr($p, 'pubpid');
        $fname = $afRowStr($p, 'fname');
        $lname = $afRowStr($p, 'lname');
        // Offset lives in the strtotime() string (not arithmetic on its result)
        // to stay inside the fork's strict phpstan (no binary op on int|false).
        // reference: seed_cardiology_demo.php
        $slotTs = strtotime("$date " . sprintf('%02d:00:00', $startHour) . " +" . $offsets[$slot] . " minutes");
        if ($slotTs === false) {
            continue; // controlled input; guard narrows $slotTs to int for date()
        }
        $startTime = date('H:i:s', $slotTs);

        // Idempotent on (patient, provider, date).
        $exists = $afRowInt(
            QueryUtils::querySingleRow(
                "SELECT pc_eid FROM openemr_postcalendar_events WHERE pc_pid = ? AND pc_aid = ? AND pc_eventDate = ? LIMIT 1",
                [$pid, $providerId, $date]
            ),
            'pc_eid'
        );
        if ($exists > 0) {
            echo sprintf("  skip  %-12s %s %s %s (already booked)\n", $pubpid, $startTime, $fname, $lname);
            $skipped++;
            continue;
        }

        if ($dryRun) {
            echo sprintf("  would %-12s %s %s %s\n", $pubpid, $startTime, $fname, $lname);
            $booked++;
            continue;
        }

        $appointmentService->insert($pid, [
            'pc_catid' => $officeVisitCatId,
            'pc_title' => 'Cardiology follow-up',
            'pc_duration' => APPT_DURATION_MIN * 60,
            'pc_hometext' => 'Cardiology follow-up',
            'pc_eventDate' => $date,
            'pc_startTime' => $startTime,
            'pc_apptstatus' => '-',
            'pc_facility' => $facilityId,
            'pc_billing_location' => $facilityId,
            'pc_aid' => $providerId,
        ]);
        echo sprintf("  book  %-12s %s %s %s\n", $pubpid, $startTime, $fname, $lname);
        $booked++;
    }
    $dayIndex++;
    echo "\n";
}

echo "Done. booked=$booked skipped=$skipped provider=$providerUsername (users.id $providerId)\n";
exit(0);
