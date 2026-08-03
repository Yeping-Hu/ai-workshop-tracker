import { topicById } from './data';

export function formatWorkshop(w: any, confName: string): string {
  const parts: string[] = [];
  
  parts.push(`## ${w.name}`);
  
  if (w.statusLabel) {
    parts.push(`Status\n${w.statusLabel}`);
  }
  
  if (w.deadlineWallClock) {
    parts.push(`Submission Deadline\n${w.deadlineWallClock}`);
  } else {
    parts.push(`Submission Deadline\nTBA`);
  }
  
  if (w.notificationDateLabel) {
    parts.push(`Notification\n${w.notificationDateLabel}`);
  }
  
  if (w.workshopDateLabel) {
    parts.push(`Workshop Date\n${w.workshopDateLabel}`);
  }
  
  if (w.topics && w.topics.length > 0) {
    parts.push(`Topics\n${w.topics.map((t: string) => `- ${topicById.get(t)?.label ?? t}`).join('\n')}`);
  }
  
  if (w.website) {
    parts.push(`Website\n[${w.website}](${w.website})`);
  }
  
  if (w.openreview_venue_id) {
    const url = `https://openreview.net/group?id=${w.openreview_venue_id}`;
    parts.push(`OpenReview\n[${url}](${url})`);
  }
  
  if (w.notes) {
    parts.push(`Description\n${w.notes}`);
  }
  
  return parts.join('\n\n');
}

export function formatConferenceYear(conf: any, year: number, wsList: any[]): string {
  const confFull = conf.full_name || conf.name;
  
  const header = [
    `# ${confFull} ${year} Workshops`,
    `Generated from AI Workshop Tracker`,
    ``,
    `Conference: ${conf.name}`,
    `Edition: ${year}`,
    ``,
    `Generated:`,
    new Date().toISOString().split('T')[0],
    ``,
    `Total Workshops: ${wsList.length}`,
    ``,
    `---`
  ].join('\n');

  const body = wsList.map(w => formatWorkshop(w, conf.name)).join('\n\n---\n\n');

  return `${header}\n\n${body}`;
}

export function formatSingleWorkshopInfo(w: any, conf: any): string {
  const confFull = conf.full_name || conf.name;
  
  const header = [
    `# ${w.name}`,
    `Generated from AI Workshop Tracker`,
    ``,
    `Conference: ${confFull}`,
    `Edition: ${w.year}`,
    ``,
    `Generated:`,
    new Date().toISOString().split('T')[0],
    ``,
    `---`
  ].join('\n');

  // Strip the '## ' from the first line since the header already has '# w.name'
  const bodyParts = formatWorkshop(w, conf.name).split('\n\n');
  bodyParts.shift(); 
  const body = bodyParts.join('\n\n');

  return `${header}\n\n${body}`;
}
