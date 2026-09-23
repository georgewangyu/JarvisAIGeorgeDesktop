export const IDEA_GROUPS = [
  {
    title: 'Featured ideas',
    ideas: [
      { id: 'plan-day', title: 'Plan my day', description: 'Turn today’s priorities into a realistic plan.', prompt: 'Help me plan today around my calendar, priorities, and energy.' },
      { id: 'catch-up', title: 'Catch me up', description: 'Find the important things to pick up next.', prompt: 'Give me a concise catch-up on what needs my attention today.' }
    ]
  },
  {
    title: 'Shopping',
    ideas: [
      { id: 'compare-purchase', title: 'Compare a purchase', description: 'Set the criteria before deciding what to buy.', prompt: 'Help me compare a purchase. First ask what I am considering, what matters to me, and my budget. Do not buy anything.' },
      { id: 'find-tradeoffs', title: 'Find the tradeoffs', description: 'Sort through competing options in one conversation.', prompt: 'Help me compare the options I am considering and surface the tradeoffs. Ask what I value before recommending anything.' }
    ]
  },
  {
    title: 'Productivity',
    ideas: [
      { id: 'prepare-meeting', title: 'Prepare for a meeting', description: 'Walk in knowing the context and decisions to make.', prompt: 'Help me prepare for an upcoming meeting and identify the decisions I need to make.' },
      { id: 'organize-project', title: 'Organize a project', description: 'Break an idea into milestones and next actions.', prompt: 'Turn a project I have in mind into a clear plan with milestones and next actions.' },
      { id: 'build-routine', title: 'Build a routine', description: 'Design a repeatable rhythm before automating it.', prompt: 'Help me create a realistic recurring routine and decide what Jarvis should automate.' }
    ]
  },
  {
    title: 'Relationships',
    ideas: [
      { id: 'draft-message', title: 'Draft a thoughtful message', description: 'Find the right words without sending anything yet.', prompt: 'Help me draft a thoughtful message. Ask who it is for and what I want to say. Do not send it.' },
      { id: 'reconnect', title: 'Make time to reconnect', description: 'Plan a simple way to catch up with someone.', prompt: 'Help me plan a low-pressure way to reconnect with someone. Ask about our relationship and what would feel natural.' }
    ]
  },
  {
    title: 'Financial planning',
    ideas: [
      { id: 'savings-goal', title: 'Map a savings goal', description: 'Define a target and the questions needed for a plan.', prompt: 'Help me clarify a savings goal. Ask about the target, timeline, and constraints before suggesting a plan. Do not move money or open accounts.' }
    ]
  },
  {
    title: 'Health & fitness',
    ideas: [
      { id: 'activity-goal', title: 'Set an activity goal', description: 'Start with an outcome and a pace you can sustain.', prompt: 'Help me clarify a general activity goal and a realistic pace. Ask about my current routine and constraints before suggesting a plan.' },
      { id: 'plan-workout', title: 'Plan a workout', description: 'Shape a session around your time and available gear.', prompt: 'Help me plan a general workout. Ask about my time, available equipment, experience, and any limitations first.' }
    ]
  },
  {
    title: 'Explore',
    ideas: [
      { id: 'research-decision', title: 'Research a decision', description: 'Get clear on the options before choosing a path.', prompt: 'Help me research a decision, compare the options, and surface the tradeoffs.' }
    ]
  }
] as const

export const IDEA_IDS = new Set<string>(IDEA_GROUPS.flatMap(group => group.ideas.map(idea => idea.id)))
