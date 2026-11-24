import { Link } from 'react-router-dom'
import { Sparkles, MessageCircle, BookOpen, ShieldCheck } from 'lucide-react'
import { Seo } from '../components/Seo'
import { seo } from '../seo'

export default function Landing() {
  return (
    <>
      <Seo {...seo} path="/" />
      <div className="landing" data-testid="static-landing">
        <header className="landing-nav">
          <Link to="/" className="brand">
            <span>♞</span>ChessMentor
          </Link>
          <Link className="secondary-button" to="/home">
            Enter the app
          </Link>
        </header>
        <main>
          <section className="landing-hero">
            <div className="eyebrow">
              <Sparkles size={15} /> A DIFFERENT WAY TO LEARN CHESS
            </div>
            <h1>
              Don’t just make a move.
              <br />
              <em>Understand it.</em>
            </h1>
            <p>
              A board, a thoughtful opponent, and a mentor by your side.
              <br />
              Explore the possibilities before you choose your next move.
            </p>
            <Link className="primary-button" to="/home">
              Find your next move
            </Link>
            <div className="landing-chess" aria-hidden>
              <span>♜</span>
              <span>♞</span>
              <span>♝</span>
              <span>♛</span>
              <span>♚</span>
              <span>♝</span>
              <span>♞</span>
              <span>♜</span>
            </div>
          </section>
          <section className="landing-features">
            {[
              {
                icon: MessageCircle,
                title: 'Ask before you act',
                text: 'Understand threats, defenders, and possibilities with a conversational mentor.',
              },
              {
                icon: Sparkles,
                title: 'See the connections',
                text: 'Arrows and highlights bring the ideas you discuss to life on your board.',
              },
              {
                icon: BookOpen,
                title: 'Return to the lesson',
                text: 'Every move and conversation stays with your game, ready to explore again.',
              },
            ].map(({ icon: Icon, title, text }) => (
              <article key={title}>
                <Icon size={22} />
                <h2>{title}</h2>
                <p>{text}</p>
              </article>
            ))}
          </section>
        </main>
        <footer>
          <ShieldCheck size={15} /> Private games. No clock. Space to think.
        </footer>
      </div>
    </>
  )
}
