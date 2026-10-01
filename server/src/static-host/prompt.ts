// Always-on description for `pimote_static_host`. Keep the long-answer
// admonition here so it can influence whether the tool is called; defer report
// design and layout instructions to the on-demand `static-report` skill.

export const STATIC_HOST_TOOL_DESCRIPTION: string = [
  "Host a static HTML/asset bundle from a local folder so the user can view it in their browser. Returns a URL and creates a tappable card in the user's session.",
  '',
  '**Use this by default for long answers; do not ask permission first.** If the answer you are about to give is roughly 300+ words, spans more than a few paragraphs, or needs headings or sections, do not deliver it as a long markdown chat response: build and host an HTML report instead. Also use it for information that benefits from visual layout or interaction, such as comparisons, charts, diffs, code walkthroughs, or navigable data.',
  '',
  'Keep the chat reply to a short summary plus the card. The report replaces the long answer; do not paste a full copy into chat. Short answers stay in chat.',
  '',
  'Before authoring a report bundle, read the `static-report` skill for report design guidance.',
  '',
  '**No secrets.** Bundle files are served verbatim. Do not include API keys, tokens, credentials, or calls to services requiring authentication.',
  '',
  '**Workflow.** Create a folder containing at least `index.html`, then call this tool with its absolute path, a short lowercase slug, and a card title. The user opens the hosted report from the session card.',
].join('\n');
