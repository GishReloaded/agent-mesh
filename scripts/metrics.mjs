#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fetchJson = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Public metrics request failed: ${response.status} ${url}`);
  return response.json();
};
const repository = 'Tandryx/tandryx';
const repo = await fetchJson(`https://api.github.com/repos/${repository}`);
const releases = await fetchJson(`https://api.github.com/repos/${repository}/releases?per_page=100`);
const packages = [];
for (const directory of ['protocol', 'sdk', 'cli']) {
  const { name } = JSON.parse(
    readFileSync(new URL(`../packages/${directory}/package.json`, import.meta.url), 'utf8'),
  );
  const [registry, downloads] = await Promise.all([
    fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`),
    fetchJson(`https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(name)}`),
  ]);
  packages.push({
    name,
    publishedVersion: registry?.['dist-tags']?.latest ?? null,
    lastMonthDownloads: downloads?.downloads ?? null,
    period: downloads ? { start: downloads.start, end: downloads.end } : null,
  });
}
console.log(
  JSON.stringify(
    {
      collectedAt: new Date().toISOString(),
      repository,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      openIssuesAndPRs: repo.open_issues_count,
      publicReleases: releases.filter((release) => !release.draft).length,
      packages,
      note: 'Public counters, not unique users or proof of ecosystem impact.',
    },
    null,
    2,
  ),
);
