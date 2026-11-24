import { useEffect, useRef, useState } from 'react'
import { Send, Sparkles, MessageCircle, RotateCcw } from 'lucide-react'
import type { Annotation, Message, Feedback, Row } from '../../chess/types'
import { coachingTimeline } from '../../chess/conversation'
interface Props {
  messages: Row<Message>[]
  feedback: Row<Feedback>[]
  ply: number
  busy: boolean
  savingMove?: boolean
  previewingBranch?: boolean
  reflecting?: boolean
  selectedId?: string
  onAsk: (question: string, requestId: string, ply: number, fen?: string) => Promise<boolean>
  onSelect: (ply: number, annotations: Annotation[], id: string) => void
}
export function MentorPanel({
  messages,
  feedback,
  ply,
  busy,
  savingMove,
  previewingBranch,
  reflecting,
  selectedId,
  onAsk,
  onSelect,
}: Props) {
  const [question, setQuestion] = useState('')
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const sending = useRef(false)
  const retryPly = useRef<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const locked = busy || submitting || savingMove || previewingBranch
  const timeline = coachingTimeline(messages, feedback)
  const contentVersion = timeline
    .map((m) => `${m.recordId}:${m.data.status}:${m.data.content}`)
    .join('|')
  const messageList = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Scroll only the conversation, never its page ancestors (especially on mobile).
    if (messageList.current) messageList.current.scrollTop = messageList.current.scrollHeight
  }, [contentVersion, locked])
  async function send(text: string, turnId: string, targetPly: number, fen?: string) {
    if (sending.current || busy || savingMove || previewingBranch) return false
    sending.current = true
    setSubmitting(true)
    try {
      return await onAsk(text, turnId, targetPly, fen)
    } finally {
      sending.current = false
      setSubmitting(false)
    }
  }
  async function submit() {
    if (!question.trim() || locked || sending.current) return
    const draft = question
    const targetPly = retryPly.current ?? ply
    setQuestion('')
    if (await send(draft, requestId, targetPly)) {
      setRequestId(crypto.randomUUID())
      retryPly.current = null
    } else {
      retryPly.current = targetPly
      setQuestion(draft)
    }
  }
  return (
    <aside className="mentor-panel">
      <header className="mentor-heading">
        <div className="mentor-icon">
          <Sparkles size={20} />
        </div>
        <div>
          <h2>Your chess mentor</h2>
          <p>Understand the position. Find your move.</p>
        </div>
      </header>
      <div className="mentor-context">
        <span>POSITION IN FOCUS</span>
        <strong>{ply === 0 ? 'Starting position' : `Ply ${ply}`}</strong>
      </div>
      <div className="messages" ref={messageList} aria-live="polite">
        {timeline.length === 0 && (
          <div className="mentor-intro">
            <MessageCircle size={26} />
            <h3>A good move starts with a question.</h3>
            <p>
              Explore threats, defenders, and possibilities before you decide. I’ll help you see the
              ideas on the board.
            </p>
            <div className="suggestions">
              {[
                'What should I pay attention to?',
                'Which pieces need defending?',
                'How can I improve my position?',
              ].map((q) => (
                <button key={q} disabled={locked} onClick={() => setQuestion(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {timeline.map((m) => (
          <article
            key={m.recordId}
            className={`message ${m.data.role} ${m.data.requestId.startsWith('feedback:') ? 'feedback' : ''} ${selectedId === m.recordId ? 'chosen' : ''}`}
          >
            <div className="message-label">
              {m.data.role === 'coach' ? <Sparkles size={13} /> : null}
              {m.data.requestId.startsWith('feedback:')
                ? `MOVE REFLECTION · PLY ${m.data.linkedPly}`
                : m.data.role === 'coach'
                  ? 'MENTOR'
                  : 'YOU'}
              <button onClick={() => onSelect(m.data.linkedPly, m.data.annotations, m.recordId)}>
                Ply {m.data.linkedPly}
              </button>
            </div>
            <button
              className="message-content"
              onClick={() => onSelect(m.data.linkedPly, m.data.annotations, m.recordId)}
              aria-label={`View ${m.data.role === 'player' ? 'question' : 'response'} at ply ${m.data.linkedPly}`}
            >
              {m.data.status === 'pending' ? 'Thinking about this position…' : m.data.content}
            </button>
            {m.data.role === 'coach' &&
              m.data.status === 'completed' &&
              m.data.annotations.length > 0 && (
                <button
                  className="text-button"
                  onClick={() => onSelect(m.data.linkedPly, m.data.annotations, m.recordId)}
                >
                  Show {m.data.annotations.length} board annotations
                </button>
              )}
            {m.data.role === 'coach' && m.data.status !== 'completed' && !locked && (
              <button
                className="text-button"
                onClick={() => {
                  const q = messages.find(
                    (q) => q.data.requestId === m.data.requestId && q.data.role === 'player',
                  )
                  if (q)
                    void send(
                      q.data.content,
                      m.data.requestId,
                      m.data.linkedPly,
                      m.data.positionFen,
                    )
                }}
              >
                <RotateCcw size={13} /> Retry response
              </button>
            )}
          </article>
        ))}
        {(busy || submitting) && (
          <p className="thinking" role="status">
            <span className="pulse" /> Mentor is thinking…
          </p>
        )}
        {reflecting && (
          <p className="thinking" role="status">
            <span className="pulse" /> Preparing a move reflection…
          </p>
        )}
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="sr-only" htmlFor="mentor-question">
          Ask about the selected position
        </label>
        <textarea
          id="mentor-question"
          maxLength={2000}
          rows={3}
          placeholder="Ask about this position…"
          value={question}
          disabled={locked}
          onChange={(e) => {
            setQuestion(e.target.value)
            setRequestId(crypto.randomUUID())
            retryPly.current = null
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
        />
        <div>
          <span role="status">
            {previewingBranch
              ? 'Create or cancel the branch to continue coaching.'
              : savingMove
                ? 'Waiting for your move to save…'
                : locked
                  ? 'Waiting for your mentor…'
                  : 'Questions welcome. Decisions are yours.'}
          </span>
          <button
            className="send-button"
            type="submit"
            disabled={locked || !question.trim()}
            aria-label="Send question"
          >
            <Send size={17} />
          </button>
        </div>
      </form>
      <p className="mentor-note">AI guidance can be imperfect. Explore, question, learn.</p>
    </aside>
  )
}
