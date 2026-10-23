const BASE = 'http://127.0.0.1:3920'

const LANE = {
  happy: { r: 0.93, g: 0.96, b: 0.93 },
  unhappy: { r: 0.98, g: 0.93, b: 0.93 },
  edge: { r: 0.98, g: 0.96, b: 0.9 },
  variant: { r: 0.94, g: 0.94, b: 0.96 },
}

function solid(color) {
  return [{ type: 'SOLID', color }]
}

async function loadImage(url) {
  const res = await fetch(url)
  if (!res.ok) return null
  const bytes = new Uint8Array(await res.arrayBuffer())
  return figma.createImage(bytes)
}

async function run() {
  const res = await fetch(`${BASE}/api/figma`)
  const doc = await res.json()
  if (!doc.ok) throw new Error(doc.error || 'FlowMap has no board yet')

  const page = figma.currentPage
  let y = 80
  const title = figma.createText()
  title.fontName = { family: 'Inter', style: 'Medium' }
  title.characters = doc.name || 'FlowMap'
  title.fontSize = 28
  title.x = 0
  title.y = 0
  page.appendChild(title)

  for (const lane of doc.lanes) {
    let x = 0
    const label = figma.createText()
    label.fontName = { family: 'Inter', style: 'Regular' }
    label.characters = lane.name
    label.fontSize = 13
    label.x = 0
    label.y = y
    page.appendChild(label)
    y += 28
    for (const step of lane.steps) {
      const frame = figma.createFrame()
      frame.name = step.name
      frame.resize(280, 210)
      frame.x = x
      frame.y = y
      frame.fills = solid(LANE[lane.kind] || LANE.variant)
      frame.clipsContent = true
      if (step.image) {
        const image = await loadImage(step.image)
        if (image) {
          const rect = figma.createRectangle()
          rect.resize(280, 158)
          rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }]
          frame.appendChild(rect)
        }
      }
      const caption = figma.createText()
      caption.fontName = { family: 'Inter', style: 'Medium' }
      caption.characters = step.name.slice(0, 42)
      caption.fontSize = 12
      caption.x = 12
      caption.y = 170
      frame.appendChild(caption)
      page.appendChild(frame)
      x += 312
    }
    y += 250
  }
  figma.notify(`Imported ${doc.name}`)
  figma.closePlugin()
}

figma
  .loadFontAsync({ family: 'Inter', style: 'Regular' })
  .then(() => figma.loadFontAsync({ family: 'Inter', style: 'Medium' }))
  .then(run)
  .catch((err) => figma.closePlugin(String(err.message || err)))
