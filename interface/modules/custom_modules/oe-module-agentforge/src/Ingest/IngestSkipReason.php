<?php

/**
 * Why a document-ingest run did nothing. Backed because the last reason logged is persisted (the
 * `agentforge_ingest_skip_notice` global), so a permanently unconfigured install warns once, not every run.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Ingest;

enum IngestSkipReason: string
{
    case IngestUriUnset = 'ingest_uri_unset';
    case CategoryMapUnset = 'category_map_unset';
    case CategoryMapUnparseable = 'category_map_unparseable';
    case CategoryMapHasNoValidEntries = 'category_map_no_valid_entries';

    /** A fixed message naming the setting to fix - never interpolated, so nothing variable reaches the log. */
    public function message(): string
    {
        return match ($this) {
            self::IngestUriUnset => 'AgentForge document ingest skipped: no ingest URI is configured. '
                . 'Set the AGENTFORGE_INGEST_URI environment variable or the agentforge_ingest_uri global.',
            self::CategoryMapUnset => 'AgentForge document ingest skipped: no category map is configured. '
                . 'Set the AGENTFORGE_INGEST_CATEGORY_MAP environment variable or the agentforge_ingest_category_map global.',
            self::CategoryMapUnparseable => 'AgentForge document ingest skipped: the category map is set but is not '
                . 'a JSON object. Fix the AGENTFORGE_INGEST_CATEGORY_MAP environment variable or the '
                . 'agentforge_ingest_category_map global.',
            self::CategoryMapHasNoValidEntries => 'AgentForge document ingest skipped: the category map is set but '
                . 'maps no category to a recognised docType (lab_pdf or intake_form). Fix the '
                . 'AGENTFORGE_INGEST_CATEGORY_MAP environment variable or the agentforge_ingest_category_map global.',
        };
    }
}
