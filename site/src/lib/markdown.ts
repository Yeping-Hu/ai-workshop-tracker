import { topicById } from './data.ts';

export const AUTO_TOPICS_NOTE = 'Topics were auto-suggested and may be imprecise — edits welcome.';

/**
 * True if `notes` is the bot's auto-suggested-topics note or a seed note,
 * so we drop it from the exported Description.
 */
export function isAutoTopicsNote(notes?: string | null): boolean {
  if (!notes || typeof notes !== 'string') return false;
  const trimmed = notes.trim();
  if (trimmed === AUTO_TOPICS_NOTE) return true;
  if (trimmed.includes('auto-suggested and may be imprecise')) return true;
  if (trimmed.includes('SEED DATA')) return true;
  if (/^Auto-imported from the OpenReview venue record on \d{4}-\d{2}-\d{2} — please verify and enrich \(topics are keyword-guessed\)\.?$/.test(trimmed)) return true;
  return false;
}

export function formatWorkshop(w: any, confName?: string): string {
  const parts: string[] = [];

  parts.push(`## ${w.name}`);

  const details: string[] = [];

  if (w.statusLabel) {
    details.push(`- **Status:** ${w.statusLabel}`);
  }

  if (w.abstractDeadlineWallClock) {
    const passedTag = w.abstractDeadlinePassed ? ' (closed)' : '';
    details.push(`- **Abstract Deadline:** ${w.abstractDeadlineWallClock}${passedTag}`);
  }

  if (w.deadlineWallClock) {
    details.push(`- **Submission Deadline:** ${w.deadlineWallClock}`);
  } else {
    details.push(`- **Submission Deadline:** TBA`);
  }

  if (w.notificationDateLabel) {
    details.push(`- **Notification:** ${w.notificationDateLabel}`);
  }

  if (w.workshopDateLabel) {
    details.push(`- **Workshop Date:** ${w.workshopDateLabel}`);
  }

  if (w.website) {
    details.push(`- **Website:** [${w.website}](${w.website})`);
  }

  if (w.openreview_venue_id) {
    const url = `https://openreview.net/group?id=${w.openreview_venue_id}`;
    details.push(`- **OpenReview:** [${url}](${url})`);
  }

  if (details.length > 0) {
    parts.push(details.join('\n'));
  }

  if (w.topics && w.topics.length > 0) {
    const topicLabels = w.topics.map((t: string) => `- ${topicById.get(t)?.label ?? t}`).join('\n');
    parts.push(`**Topics:**\n${topicLabels}`);
  }

  if (w.deadlineChange) {
    if (w.deadlineChange.kind === 'extended') {
      parts.push(`- **Deadline History:** Extended by ${w.deadlineChange.days} ${w.deadlineChange.days === 1 ? 'day' : 'days'} (previously ${w.deadlineChange.fromWallClock})`);
    } else if (w.deadlineChange.kind === 'earlier') {
      parts.push(`- **Deadline History:** Moved ${w.deadlineChange.days} ${w.deadlineChange.days === 1 ? 'day' : 'days'} earlier (previously ${w.deadlineChange.fromWallClock})`);
    } else if (w.deadlineChange.kind === 'announced') {
      parts.push(`- **Deadline History:** First deadline posted`);
    }
  } else if (Array.isArray(w.deadlineHistoryView) && w.deadlineHistoryView.length > 1) {
    const historyLines = w.deadlineHistoryView.map((h: any, i: number) => {
      const tag = i === w.deadlineHistoryView.length - 1 ? 'first recorded' : 'changed';
      return `  - ${h.recordedLabel}: ${h.wallClock ?? 'no date published'} (${tag})`;
    }).join('\n');
    parts.push(`- **Deadline History:**\n${historyLines}`);
  }

  if (w.notes && !isAutoTopicsNote(w.notes)) {
    parts.push(`**Description:**\n${w.notes}`);
  }

  return parts.join('\n\n');
}

export function formatConferenceYear(conf: any, year: number, wsList: any[]): string {
  const confFull = conf.full_name || conf.name;
  const genDate = new Date().toISOString().split('T')[0];

  const header = [
    `# ${confFull} ${year} Workshops`,
    `Generated from AI Workshop Tracker`,
    ``,
    `Conference: ${conf.name}`,
    `Edition: ${year}`,
    `Data snapshot: ${genDate}`,
    `Total Workshops: ${wsList.length}`,
    ``,
    `---`
  ].join('\n');

  const body = wsList.map(w => formatWorkshop(w, conf.name)).join('\n\n---\n\n');

  return `${header}\n\n${body}`;
}

export function formatSingleWorkshopInfo(w: any, conf: any): string {
  const confFull = conf.full_name || conf.name;
  const genDate = new Date().toISOString().split('T')[0];

  const header = [
    `# ${w.name}`,
    `Generated from AI Workshop Tracker`,
    ``,
    `Conference: ${confFull}`,
    `Edition: ${w.year}`,
    `Data snapshot: ${genDate}`,
    ``,
    `---`
  ].join('\n');

  // Strip the '## ' line from formatWorkshop output since header already has '# w.name'
  const bodyParts = formatWorkshop(w, conf.name).split('\n\n');
  bodyParts.shift();
  const body = bodyParts.join('\n\n');

  return `${header}\n\n${body}`;
}
