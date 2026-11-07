<?php

/**
 * What became of one document's forward: accepted, or why it was not. The reason decides whether the sidecar's
 * health matters to the retry bound, and which remedy the give-up log names. The values are logged, so they are
 * fixed strings - never the document, its name or its patient.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Ingest;

enum IngestForwardResult: string
{
    /** The sidecar accepted the document (200: ingested, or already on file). */
    case Forwarded = 'forwarded';

    /** The sidecar was asked and did not accept: a non-200 or a transport failure. */
    case Rejected = 'rejected';

    /** The document's patient has no FHIR UUID, so there is nothing to key the facts on; the sidecar was not asked. */
    case NoPatientUuid = 'no_patient_uuid';

    /**
     * The document's file could not be read at all: a missing or unreadable file, a failed decryption, an expired
     * document, a storage backend that is down. The sidecar was not asked.
     */
    case Unreadable = 'unreadable';

    /** The file was read and is zero bytes; the sidecar was not asked. */
    case EmptyFile = 'empty_file';

    /** The document has no UUID of its own to use as the FHIR DocumentReference id; the sidecar was not asked. */
    case NoDocumentUuid = 'no_document_uuid';

    /**
     * True when OpenEMR read this document's file, so its storage was working. A storage outage fails every read
     * at once, so a document that could not be read counts against the retry bound only in a run where another
     * file was read.
     */
    public function fileWasRead(): bool
    {
        return match ($this) {
            self::Forwarded, self::Rejected, self::EmptyFile, self::NoDocumentUuid => true,
            self::NoPatientUuid, self::Unreadable => false,
        };
    }

    /**
     * Whether a run in which the document failed this way counts towards giving up on it. A failure an outage
     * could explain counts only with evidence from the same run that the outage is not on:
     *
     * - a sidecar rejection, only if the sidecar newly accepted another document;
     * - an unreadable file, only if another file was read.
     *
     * The rest are facts about the one document that no outage explains, so they always count.
     */
    public function countsAgainstDocument(bool $sidecarNewlyAcceptedAnother, bool $anotherFileWasRead): bool
    {
        return match ($this) {
            self::Forwarded => false,
            self::Rejected => $sidecarNewlyAcceptedAnother,
            self::Unreadable => $anotherFileWasRead,
            self::NoPatientUuid, self::EmptyFile, self::NoDocumentUuid => true,
        };
    }

    /** A fixed message naming the cause and the remedy - never interpolated, so nothing variable reaches the log. */
    public function giveUpMessage(): string
    {
        return match ($this) {
            self::Forwarded => throw new \LogicException('An accepted document is never given up on.'),
            self::Rejected => 'AgentForge document ingest gave up on a document the sidecar kept rejecting. '
                . 'Check the sidecar, then re-upload the document.',
            self::NoPatientUuid => 'AgentForge document ingest gave up on a document whose patient has no FHIR UUID. '
                . 'Give the patient a UUID, then re-upload the document.',
            self::Unreadable => 'AgentForge document ingest gave up on a document whose file could not be read. '
                . 'Check the document storage and its encryption key, then re-upload the document.',
            self::EmptyFile => 'AgentForge document ingest gave up on a document whose file is empty. '
                . 'Upload the document again with its content.',
            self::NoDocumentUuid => 'AgentForge document ingest gave up on a document that has no UUID of its own. '
                . 'Re-upload the document so it gets one.',
        };
    }
}
