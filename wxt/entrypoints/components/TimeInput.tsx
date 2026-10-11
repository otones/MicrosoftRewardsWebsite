interface TimeInputProps {
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
}

// The local time the daily run is due at. A native time input, so the browser
// supplies the picker and hands back the "HH:MM" the scheduler parses — no
// free-text field whose contents would have to be repaired on every run.
function TimeInput({ id, label, value, onChange }: TimeInputProps) {
    return (
        <span className="field field--time">
            <input type="time" id={id} value={value} onChange={(e) => onChange(e.target.value)} />
            <label htmlFor={id}>{label}</label>
        </span>
    );
}

export default TimeInput;
