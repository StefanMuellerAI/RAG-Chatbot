export default function Loading() {
  return (
    <div className="karte chat-ladeansicht" role="status" aria-label="Sammlungen werden geladen">
      <p>Sammlungen werden geladen …</p>
      <div className="chat-skelett" aria-hidden="true"><div /><div /></div>
    </div>
  );
}
