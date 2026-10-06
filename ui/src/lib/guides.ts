// First-run guides: which ones the user has dismissed (localStorage), the step
// lists for each page, and the glossary shown in the help panel.

import { useSyncExternalStore } from 'react'

export type Page = 'home' | 'apps' | 'agents' | 'activity' | 'brain' | 'settings' | 'approvals'

const KEY = 'brain.guides.v1'
type State = { welcome?: boolean; checklist?: boolean; intros?: Partial<Record<Page, boolean>> }

const listeners = new Set<() => void>()
let cache: State | null = null

function read(): State {
  if (cache) return cache
  try {
    cache = JSON.parse(localStorage.getItem(KEY) || '{}') as State
  } catch {
    cache = {}
  }
  return cache
}

function write(next: State) {
  cache = next
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable: guides just come back next visit */
  }
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useGuides() {
  const state = useSyncExternalStore(subscribe, read, read)
  return {
    welcomeSeen: !!state.welcome,
    checklistHidden: !!state.checklist,
    introHidden: (page: Page) => !!state.intros?.[page],
    seeWelcome: () => write({ ...read(), welcome: true }),
    hideChecklist: () => write({ ...read(), checklist: true }),
    hideIntro: (page: Page) => write({ ...read(), intros: { ...read().intros, [page]: true } }),
    showIntro: (page: Page) => write({ ...read(), intros: { ...read().intros, [page]: false } }),
    reset: () => write({}),
  }
}

export type Guide = { title: string; summary: string; steps: { title: string; body: string }[]; action?: string }

export const GUIDES: Record<Page, Guide> = {
  home: {
    title: 'How Home works',
    summary: 'Home shows what needs you right now and how your agents have been busy.',
    steps: [
      { title: 'Check “Needs you”', body: 'Agents wait here when they want to change something. Approve once, for an hour, or deny.' },
      { title: 'Fix apps that need you', body: 'An app that lost its sign-in shows a Reconnect button. New or changed tools ask for a quick review.' },
      { title: 'Glance at recent activity', body: 'The last few things your agents did, in plain words. Open Activity for the full history.' },
      { title: 'Finish Getting started', body: 'Four steps take you from nothing to an agent using your apps safely.' },
    ],
    action: 'Connect an app',
  },
  apps: {
    title: 'How Apps works',
    summary: 'Apps are the services your agents can use for you: Figma, Linear, Gmail and so on.',
    steps: [
      { title: 'Open the directory', body: 'Pick an app. Most connect with one click: you sign in at the app and come straight back.' },
      { title: 'Choose who can use it', body: 'Every app starts as read only for all agents. Raise it to “Read & change” or “Everything” when you trust it.' },
      { title: 'Ask before changes', body: 'Turn on “Ask me before it changes anything” and every change waits for your approval.' },
      { title: 'Review new tools', body: 'When an app adds or changes a tool, agents cannot use it until you look at it.' },
    ],
    action: 'Open the directory',
  },
  agents: {
    title: 'How Agents works',
    summary: 'An agent is an AI tool like Claude Code, Codex or Cursor, running on one of your devices.',
    steps: [
      { title: 'Install the brain CLI', body: 'One command on the device. It sets up every agent it finds there.' },
      { title: 'Run brain login', body: 'It shows a short code and opens this console.' },
      { title: 'Enter the code and approve', body: 'Each agent gets its own key, so you can see and limit what each one does.' },
    ],
    action: 'Add a device',
  },
  activity: {
    title: 'How Activity works',
    summary: 'Every time an agent uses an app, or you change something, it shows up here.',
    steps: [
      { title: 'Read it like a timeline', body: 'Newest first, grouped by day. Each row says who did what, in which app.' },
      { title: 'Spot problems fast', body: 'Blocked and failed rows say why. Waiting rows link to your approvals.' },
      { title: 'Filter', body: 'Narrow down by agent, app or outcome.' },
    ],
  },
  brain: {
    title: 'How the Brain works',
    summary: 'Your Brain is a set of notes your agents read and write: projects, decisions, sessions and skills.',
    steps: [
      { title: 'Browse notes', body: 'Pick a note from the list. Links between notes are clickable.' },
      { title: 'See the graph', body: 'How your notes connect to each other, at a glance.' },
      { title: 'Choose skills', body: 'Skills are instructions agents load for a project. Pick which ones each project gets.' },
      { title: 'Check health', body: 'Unsaved sessions, stale projects and broken links, with one-click fixes.' },
    ],
  },
  settings: {
    title: 'How Settings works',
    summary: 'Your account, keys, sharing and notifications. Advanced rules live here too.',
    steps: [
      { title: 'Turn on phone notifications', body: 'Get a push the moment an agent waits for you.' },
      { title: 'Share projects with people', body: 'Give a teammate access to one project in your Brain, not the whole thing.' },
      { title: 'Advanced rules (optional)', body: 'The Apps page writes rules for you. Edit them by hand only if you need something it cannot express.' },
    ],
    action: 'Set up notifications',
  },
  approvals: {
    title: 'How approvals work',
    summary: 'When an agent wants to do something you asked to check, it waits here until you decide.',
    steps: [
      { title: 'Read what it wants to do', body: 'You see the agent, the app, the action and the exact details it will send.' },
      { title: 'Decide', body: 'Approve once, approve for an hour (handy for a batch of similar calls), or deny.' },
      { title: 'The agent carries on', body: 'It retries on its own once you approve.' },
    ],
  },
}

export const GLOSSARY: { term: string; body: string }[] = [
  { term: 'App', body: 'A service your agents can use, like Figma or Linear. Connecting it lets agents use it without ever seeing your password.' },
  { term: 'Account', body: 'Which login of that app. You can connect several, for example Figma work and Figma personal.' },
  { term: 'Agent', body: 'An AI tool acting for you, like Claude Code, Codex or Cursor. Each one gets its own key.' },
  { term: 'Device', body: 'A computer an agent runs on: your laptop, a desktop, or a server.' },
  { term: 'Access level', body: 'What agents may do in an app: Off, Read (look things up), Read & change, or Everything (including delete).' },
  { term: 'Approval', body: 'A pause where an agent waits for your OK before doing something. You can approve once, for an hour, or deny.' },
  { term: 'Reads untrusted data', body: 'The app returns content written by other people (emails, web pages, comments). It might contain text that tries to trick an agent, so BrainMCP is more careful afterwards.' },
  { term: 'Sends data out', body: 'An action that sends something outside the app: an email, a post, an upload. After reading untrusted data, these ask you first.' },
  { term: 'Shared app', body: 'An app someone else connected and shared with you. You use it through them and never see their password.' },
  { term: 'Brain note', body: 'A Markdown note in your Brain. Agents read them for context and write new ones, like session summaries and decisions.' },
  { term: 'Skill', body: 'A set of instructions an agent loads for a kind of task. You choose which skills each project gets.' },
]
