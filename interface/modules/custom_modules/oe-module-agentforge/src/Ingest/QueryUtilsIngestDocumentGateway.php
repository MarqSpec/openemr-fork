<?php

/**
 * The production IngestDocumentGateway: finds new documents with QueryUtils and hands each to IngestForwarder to
 * be read and sent to the sidecar.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge
 * @copyright Copyright (c) 2026 AgentForge
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\AgentForge\Ingest;

use OpenEMR\Common\Database\QueryUtils;

final readonly class QueryUtilsIngestDocumentGateway implements IngestDocumentGateway
{
    public function __construct(private IngestForwarder $forwarder)
    {
    }

    public function findDocumentsAfter(int $watermark, array $categoryMap): array
    {
        if ($categoryMap === []) {
            return [];
        }

        // documents<->category is the categories_to_documents join; patient_data resolves the patient's FHIR
        // UUID from documents.foreign_id (the internal pid). The sidecar keys derived facts on the UUID, not
        // the pid, so the join is required, not cosmetic - an INNER JOIN also naturally drops any non-patient
        // documents. Schema verified against staging 2026-07-14.
        $categoryIds = array_keys($categoryMap);
        $placeholders = implode(',', array_fill(0, count($categoryIds), '?'));
        $sql = 'SELECT d.`id`, d.`mimetype`, d.`name`, ctd.`category_id`, pd.`uuid` AS `patient_uuid` '
            . 'FROM `documents` d '
            . 'JOIN `categories_to_documents` ctd ON ctd.`document_id` = d.`id` '
            . 'JOIN `patient_data` pd ON pd.`pid` = d.`foreign_id` '
            . 'WHERE d.`id` > ? AND d.`deleted` = 0 AND ctd.`category_id` IN (' . $placeholders . ') '
            . 'ORDER BY d.`id` ASC';

        /** @var list<array<string, mixed>> $rows */
        $rows = QueryUtils::fetchRecords($sql, array_merge([$watermark], $categoryIds));

        $documents = [];
        foreach ($rows as $row) {
            $docType = $categoryMap[self::toStr($row['category_id'])] ?? null;
            if ($docType === null) {
                continue;
            }
            $patientUuid = $row['patient_uuid'] ?? null;
            $documents[] = new IngestDocument(
                self::toInt($row['id']),
                $docType,
                self::toStr($row['mimetype'] ?? 'application/octet-stream'),
                self::toStr($row['name'] ?? 'document'),
                is_string($patientUuid) ? $patientUuid : null,
            );
        }

        return $documents;
    }

    public function forward(string $ingestUri, IngestDocument $document): IngestForwardResult
    {
        return $this->forwarder->forward($ingestUri, $document);
    }

    // QueryUtils::fetchRecords yields mixed cells; narrow before converting - the fork forbids casting mixed.
    private static function toInt(mixed $value): int
    {
        return is_numeric($value) ? (int) $value : 0;
    }

    private static function toStr(mixed $value): string
    {
        return is_scalar($value) ? (string) $value : '';
    }
}
