/**
 * Model-facing guidance for the file download tool.
 *
 * Keep the approval and liveness requirements in the tool description: the
 * registration only offers a native browser download to the user; it does not
 * copy bytes into the agent process or wait for a click.
 */
export const FILE_DOWNLOAD_TOOL_DESCRIPTION =
  'Offer a project file as a one-shot native browser download that requires an explicit user click/approval. The download is not completed until the user acts, so keep the live source file available and unchanged until then. Pass only the file path; the server derives the filename and size.';
