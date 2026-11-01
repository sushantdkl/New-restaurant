import Ornament from '@/components/public/ornament';

/** Inner-page title, centred on ivory and closed by a champagne ornament. */
export default function PageHead({ title, lead, children }) {
  return (
    <header className="rc-page-head">
      <div className="rc-wrap rc-head">
        <h1 className="rc-h1">{title}</h1>
        {lead ? <p className="rc-lead">{lead}</p> : null}
        {children}
        <Ornament />
      </div>
    </header>
  );
}
