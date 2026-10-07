import type {Condition, SettingBlock, SettingValue, ViewBlock} from "../shared/blocks"
import type {LinkLingoSettings} from "../shared/types"

/** What a block may read and change. Settings are read-only here; writes go through `onSet`. */
export interface BlockContext {
  settings: LinkLingoSettings
  /** `{input}` and `{output}` in block text become these language names. */
  vars: Record<string, string>
  onSet(key: string, value: SettingValue): void
}

const SETTING_TYPES = new Set(["toggle", "select", "slider"])

export function settingValue(settings: LinkLingoSettings, key: string): SettingValue | undefined {
  if (key.startsWith("prefs.")) return settings.prefs[key.slice("prefs.".length)]
  const value = (settings as unknown as Record<string, unknown>)[key]
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined
}

export function holds(condition: Condition | undefined, settings: LinkLingoSettings): boolean {
  if (!condition) return false
  const value = settingValue(settings, condition.key)
  if (condition.equals !== undefined) return value === condition.equals
  if (condition.notEquals !== undefined) return value !== condition.notEquals
  return Boolean(value)
}

function fill(text: string | undefined, vars: Record<string, string>): string {
  return (text ?? "").replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match)
}

/** A server-described screen. Unknown block types are skipped so a newer server cannot break an older phone. */
export function ViewBlocks({blocks, ctx}: {blocks: ViewBlock[]; ctx: BlockContext}) {
  return (
    <>
      {blocks.map((block, i) => (
        <Block key={i} block={block} ctx={ctx} />
      ))}
    </>
  )
}

function Block({block, ctx}: {block: ViewBlock; ctx: BlockContext}) {
  switch (block.type) {
    case "section":
      return (
        <section className="card">
          {block.title || block.meta ? (
            <div className="card-head">
              {block.title ? <h2 className="card-title">{fill(block.title, ctx.vars)}</h2> : <span />}
              {block.meta ? <span className="meta">{fill(block.meta, ctx.vars)}</span> : null}
            </div>
          ) : null}
          <ViewBlocks blocks={block.blocks} ctx={ctx} />
        </section>
      )
    case "tiles":
      return (
        <div className="tiles">
          {block.items.map((item, i) => (
            <div key={i} className="tile">
              <b>{typeof item.value === "number" ? item.value.toLocaleString() : item.value}</b>
              <span>{fill(item.label, ctx.vars)}</span>
            </div>
          ))}
        </div>
      )
    case "bars": {
      const peak = Math.max(1, ...block.items.map((item) => item.segments.reduce((sum, s) => sum + s.value, 0)))
      return (
        <div className="bars" aria-label={block.label}>
          {block.items.map((item, i) => (
            <div key={i} className="bar-col">
              <div className="bar-track">
                {item.segments.map((segment, j) => (
                  <div key={j} className={`bar tone-${segment.tone ?? "accent"}`} style={{height: `${(segment.value / peak) * 100}%`}} />
                ))}
              </div>
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      )
    }
    case "words":
      return (
        <Group title={block.title} hint={block.hint} vars={ctx.vars}>
          {block.items.length === 0 ? (
            block.empty ? <p className="hint">{fill(block.empty, ctx.vars)}</p> : null
          ) : (
            <div className="words">
              {block.items.map((item, i) => (
                <div key={i} className={`word-chip${item.tone === "info" ? " reverse" : item.tone === "accent" ? " upgrade" : ""}`}>
                  <b>
                    {item.word}
                    {item.badge ? <em className="count">{item.badge}</em> : null}
                  </b>
                  <small>{item.translation}</small>
                </div>
              ))}
            </div>
          )}
        </Group>
      )
    case "list":
      return (
        <Group title={block.title} hint={block.hint} vars={ctx.vars}>
          {block.items.length === 0 ? (
            block.empty ? <p className="hint">{fill(block.empty, ctx.vars)}</p> : null
          ) : (
            <ul className="report-list">
              {block.items.map((item, i) => (
                <li key={i} className={item.tone ? `tone-${item.tone}` : undefined}>
                  <span>
                    {item.was ? (
                      <>
                        <s>{item.was}</s> → <b>{item.text}</b>
                      </>
                    ) : (
                      item.text
                    )}
                  </span>
                  {item.detail ? <small>{item.detail}</small> : null}
                </li>
              ))}
            </ul>
          )}
        </Group>
      )
    case "text":
      return <p className={block.tone === "error" ? "diag-error" : block.tone === "body" ? "body-text" : "hint"}>{fill(block.text, ctx.vars)}</p>
    default:
      if (SETTING_TYPES.has((block as SettingBlock).type)) return <SettingRow block={block as SettingBlock} ctx={ctx} />
      return null
  }
}

function Group({title, hint, vars, children}: {title?: string; hint?: string; vars: Record<string, string>; children: React.ReactNode}) {
  return (
    <div className="report-group">
      {title ? <h3>{fill(title, vars)}</h3> : null}
      {hint ? <p className="hint">{fill(hint, vars)}</p> : null}
      {children}
    </div>
  )
}

/** Settings rows sent by the server, drawn with the same controls as the built-in ones. */
export function SettingRows({blocks, ctx}: {blocks: ViewBlock[]; ctx: BlockContext}) {
  return (
    <>
      {blocks.map((block, i) =>
        SETTING_TYPES.has(block.type) ? <SettingRow key={i} block={block as SettingBlock} ctx={ctx} /> : null,
      )}
    </>
  )
}

function SettingRow({block, ctx}: {block: SettingBlock; ctx: BlockContext}) {
  if (block.visibleWhen && !holds(block.visibleWhen, ctx.settings)) return null
  const disabled = holds(block.disabledWhen, ctx.settings)
  const value = settingValue(ctx.settings, block.key)
  const title = fill(block.title, ctx.vars)
  const detail = block.detail ? fill(block.detail, ctx.vars) : undefined

  if (block.type === "toggle") {
    const checked = value === true
    return (
      <div className="row">
        <span className="row-copy">
          <strong>{title}</strong>
          {detail ? <span>{detail}</span> : null}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={title}
          disabled={disabled}
          className={`switch${checked ? " on" : ""}`}
          onClick={() => ctx.onSet(block.key, !checked)}
        />
      </div>
    )
  }

  if (block.type === "select") {
    const index = block.options.findIndex((o) => o.value === value)
    return (
      <label className="row">
        <span className="row-copy">
          <strong>{title}</strong>
          {detail ? <span>{detail}</span> : null}
        </span>
        <select
          className="select"
          style={{width: 132, minHeight: 44, fontSize: 14}}
          disabled={disabled}
          value={index === -1 ? "" : String(index)}
          onChange={(e) => {
            const option = block.options[Number(e.target.value)]
            if (option) ctx.onSet(block.key, option.value)
          }}>
          {index === -1 ? <option value="">—</option> : null}
          {block.options.map((option, i) => (
            <option key={i} value={String(i)}>
              {fill(option.label, ctx.vars)}
            </option>
          ))}
        </select>
      </label>
    )
  }

  const numeric = typeof value === "number" ? value : block.min
  return (
    <label className="row-copy">
      <strong>{`${title} · ${numeric}`}</strong>
      {detail ? <span>{detail}</span> : null}
      <input
        className="slider"
        type="range"
        min={block.min}
        max={block.max}
        step={block.step ?? 1}
        value={numeric}
        disabled={disabled}
        onChange={(e) => ctx.onSet(block.key, Number(e.target.value))}
      />
    </label>
  )
}
