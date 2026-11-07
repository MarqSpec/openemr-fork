<?php

/**
 * Fail when a PHPStan baseline gains entries: the "no new baseline entries" rule as a CI gate.
 *
 * Compares two baseline directories - "base" (the pull request's merge base) and "head" (the pull
 * request) - entry by entry. An entry is the triple (identifier file, message, path); its weight is
 * its `count`. Any entry whose head count exceeds its base count is new suppression, and the script
 * lists each one and exits 1. Entries that shrink or disappear are fine: fixing errors is the point.
 *
 * PHPStan's own run (`.phpstan/phpstan.ci.neon`) already fails on errors the baseline does not
 * cover. This closes the other route: regenerating the baseline so a new error is covered by it.
 * A moved or renamed file reports its entries as new, because its path changed; fix them rather
 * than carry them.
 *
 * Fork-owned, beside upstream's `baseline-diff.php`, whose loading it mirrors.
 *
 * Usage:
 *   php .phpstan/baseline-growth.php <base-dir> <head-dir>
 *
 * Exit status: 0 no growth · 1 entries grew · 2 bad usage.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Adam Marquette
 * @copyright Copyright (c) 2026 Adam Marquette
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

if ($argc !== 3) {
    fwrite(STDERR, "Usage: php {$argv[0]} <base-dir> <head-dir>\n");
    exit(2);
}

[, $baseDir, $headDir] = $argv;

foreach (['Base' => $baseDir, 'Head' => $headDir] as $label => $dir) {
    if (!is_dir($dir)) {
        fwrite(STDERR, "{$label} baseline directory not found: {$dir}\n");
        exit(2);
    }
}

/**
 * Load one baseline file in an isolated scope. `__DIR__` inside it resolves to its own directory,
 * so paths are reported relative to that directory to compare equal across the two trees.
 *
 * @return array<string, int> count per "message\0path" key
 */
function load_entries(string $file): array
{
    $ignoreErrors = [];
    require $file;
    // `__DIR__` in the baseline file is absolute and, on Windows, backslashed; the directory given may be neither.
    $dir = realpath(dirname($file));
    $prefix = str_replace('\\', '/', $dir === false ? dirname($file) : $dir) . '/';
    $entries = [];
    foreach ($ignoreErrors as $entry) {
        $message = is_string($entry['message'] ?? null) ? $entry['message'] : '';
        $path = str_replace('\\', '/', is_string($entry['path'] ?? null) ? $entry['path'] : '');
        if (str_starts_with($path, $prefix)) {
            $path = substr($path, strlen($prefix));
        }
        $count = is_int($entry['count'] ?? null) ? $entry['count'] : 1;
        $key = $message . "\0" . $path;
        $entries[$key] = ($entries[$key] ?? 0) + $count;
    }
    return $entries;
}

/**
 * @return array<string, array<string, int>> identifier => entries
 */
function load_dir(string $dir): array
{
    $byIdentifier = [];
    foreach (glob($dir . '/*.php') ?: [] as $file) {
        $identifier = basename($file, '.php');
        if ($identifier === 'loader') {
            continue;
        }
        $byIdentifier[$identifier] = load_entries($file);
    }
    return $byIdentifier;
}

$base = load_dir($baseDir);
$head = load_dir($headDir);

$grown = [];
foreach ($head as $identifier => $entries) {
    foreach ($entries as $key => $count) {
        $before = $base[$identifier][$key] ?? 0;
        if ($count > $before) {
            [$message, $path] = explode("\0", $key, 2);
            $grown[] = sprintf('  %s  %s (+%d)  %s', $identifier, $path, $count - $before, $message);
        }
    }
}

if ($grown === []) {
    echo "PHPStan baseline: no new entries.\n";
    exit(0);
}

fwrite(STDERR, sprintf(
    "PHPStan baseline: %d new or grown entr%s. Fix the errors instead of baselining them:\n%s\n",
    count($grown),
    count($grown) === 1 ? 'y' : 'ies',
    implode("\n", $grown)
));
exit(1);
