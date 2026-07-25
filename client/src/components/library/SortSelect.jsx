// Sort keys are validated server-side against a whitelist, so an unknown value
// here degrades to the default rather than erroring.
export default function SortSelect({ value, options, onChange, label = 'Sort' }) {
  return (
    <label className="sort-select">
      <span className="muted">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </select>
    </label>
  );
}
