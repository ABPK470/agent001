/**
 * Platform phase vocabulary — fixed boundaries for sync flow scheduling.
 * Not tenant-specific; phases describe *when* a step runs, not *what* it does.
 */

export const SYNC_METADATA_PHASES = [
  {
    id: "preTransaction",
    label: "Pre-transaction",
    sortOrder: 0,
    definition: {
      summary: "Before metadata merge on target",
      description:
        "Steps run on the source database before the metadata sync transaction opens on the target. Typical uses: audit gates (syncOrNot), contract locks. Failures here stop the entire run.",
      boundary: "pre_metadata",
      connection: "source",
      defaultFailureMode: "fatal",
      orderingHint: "Must appear before the first metadataSync step in the flow array.",
    },
  },
  {
    id: "metadata",
    label: "Metadata",
    sortOrder: 1,
    definition: {
      summary: "Core metadata transaction",
      description:
        "The metadataSync step runs in a single SQL transaction on the target: applies the change set (MERGE/DELETE with FK handling). This is the only transactional metadata apply.",
      boundary: "metadata_transaction",
      connection: "target",
      defaultFailureMode: "fatal",
      orderingHint: "Exactly one metadataSync per flow; marks the split between pre- and post-metadata execution.",
    },
  },
  {
    id: "postMetadata",
    label: "Post-metadata",
    sortOrder: 2,
    definition: {
      summary: "After metadata commit",
      description:
        "Deploy actions, HTTP calls, dependency refresh, pipeline start, and post-deploy audits. Most steps warn on failure but allow the run to complete.",
      boundary: "post_metadata",
      connection: "mixed",
      defaultFailureMode: "warning",
      orderingHint: "All steps after the first metadataSync step.",
    },
  },
  {
    id: "postCommit",
    label: "Post-commit",
    sortOrder: 3,
    definition: {
      summary: "After metadata transaction commit (reserved)",
      description:
        "Reserved boundary for fire-and-forget or post-commit hooks. Steps tagged postCommit run after postMetadata in the current scheduler.",
      boundary: "post_commit",
      connection: "mixed",
      defaultFailureMode: "warning",
      orderingHint: "Runs after postMetadata steps in the current scheduler.",
    },
  },
]

export const SYNC_METADATA_PHASE_IDS = new Set(SYNC_METADATA_PHASES.map((phase) => phase.id))
