/**
 * Human Q&A callout for ask_user work — the primary signal in the detail pane.
 */

export function TraceAskUserInteraction({
  question,
  answer,
}: {
  question: string | null
  answer: string | null
}) {
  if (!question && !answer) return null

  return (
    <section className="trace-interaction-card" aria-label="User interaction">
      <div className="trace-interaction-card__label">Interaction</div>
      <div className="trace-interaction-card__body">
        {question ? (
          <div className="trace-interaction-card__row">
            <span className="trace-interaction-card__role">Question</span>
            <p className="trace-interaction-card__text">{question}</p>
          </div>
        ) : null}
        {question && answer ? <div className="trace-interaction-card__divider" aria-hidden /> : null}
        {answer ? (
          <div className="trace-interaction-card__row">
            <span className="trace-interaction-card__role">User answer</span>
            <p className="trace-interaction-card__text">{answer}</p>
          </div>
        ) : null}
      </div>
    </section>
  )
}
