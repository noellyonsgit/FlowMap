#!/usr/bin/env node
/**
 * Runs one Cursor agent turn locally through @cursor/sdk and streams its text to stdout.
 * Usage: node cursor-sdk-run.mjs <project folder> <prompt>
 * Needs `npm install @cursor/sdk` in FlowMap and CURSOR_API_KEY in the environment.
 */
import { Agent, CursorAgentError } from '@cursor/sdk'

const [folder, prompt] = process.argv.slice(2)
if (!folder || !prompt) {
  console.error('Usage: node cursor-sdk-run.mjs <project folder> <prompt>')
  process.exit(1)
}

let agent
try {
  agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: process.env.FLOWMAP_CURSOR_MODEL || 'composer-2.5' },
    local: { cwd: folder },
  })
  const run = await agent.send(prompt)
  console.error(`Cursor agent ${agent.agentId}, run ${run.id}`)
  for await (const event of run.stream()) {
    if (event.type !== 'assistant') continue
    for (const block of event.message.content) {
      if (block.type === 'text') process.stdout.write(block.text)
    }
  }
  const result = await run.wait()
  process.stdout.write('\n')
  if (result.status === 'error') {
    console.error(`The Cursor agent stopped with an error (run ${result.id}).`)
    process.exitCode = 2
  }
} catch (err) {
  if (!(err instanceof CursorAgentError)) throw err
  console.error(`Cursor agent could not start: ${err.message}`)
  process.exitCode = 1
} finally {
  await agent?.[Symbol.asyncDispose]?.()
}
