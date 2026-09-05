export default function Loading() {
  return <div className="karte chat-ladeansicht" role="status" aria-label="Ansicht wird geladen">
    <p>Ihr Arbeitsbereich wird geladen …</p>
    <div className="chat-skelett" aria-hidden="true"><div /><div /><div /></div>
  </div>;
}
