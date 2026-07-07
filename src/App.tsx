const REPO = 'https://github.com/aryannpanwarr/audio-read'
const LATEST_RELEASE = `${REPO}/releases/latest`
const VERSION = 'v0.9.0'

const features = [
  {
    title: 'Reads the real document',
    body: 'Opens your PDF or EPUB and reads it aloud over the original page — layout, figures and all. Nothing is reflowed or stripped.',
  },
  {
    title: 'Word-level highlighting',
    body: 'A moving highlight follows the voice word by word. Tap any word to jump the narration straight to that sentence.',
  },
  {
    title: 'On-device, private, free',
    body: 'Uses your phone’s built-in text-to-speech. No account, no upload, no API keys. Your files never leave the device.',
  },
  {
    title: 'Player you already know',
    body: 'Speed control, a sleep timer, and a lock-screen media notification with play / pause / skip and Bluetooth controls.',
  },
  {
    title: 'A real library',
    body: 'Keep books in folders, pick up where you left off, and manage everything from a clean, quiet home screen.',
  },
  {
    title: 'PDF and EPUB',
    body: 'Sentence-aware playback tuned for both formats, with smart handling of abbreviations, units and headings.',
  },
]

export default function App() {
  return (
    <div className="page">
      <header className="nav">
        <span className="wordmark">
          <span aria-hidden>🔊</span> Audio Read
        </span>
        <a className="nav-link" href={REPO} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </header>

      <main>
        <section className="hero">
          <p className="eyebrow">Android · Free · On-device</p>
          <h1>
            Listen to your PDFs
            <br />
            and EPUBs.
          </h1>
          <p className="lede">
            Audio Read turns any book or document into audio — read aloud on the original page,
            with the words highlighted as you go. Everything runs on your phone.
          </p>

          <div className="cta">
            <a className="btn btn-primary" href={LATEST_RELEASE} target="_blank" rel="noreferrer">
              Download the APK
            </a>
            <a className="btn btn-ghost" href={`${REPO}/releases`} target="_blank" rel="noreferrer">
              All releases
            </a>
          </div>
          <p className="fineprint">
            Latest {VERSION} · Android APK · install from the release page
          </p>
        </section>

        <section className="features">
          {features.map((f) => (
            <div className="feature" key={f.title}>
              <h2>{f.title}</h2>
              <p>{f.body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="footer">
        <span>Audio Read</span>
        <a href={REPO} target="_blank" rel="noreferrer">
          Source on GitHub
        </a>
      </footer>
    </div>
  )
}
