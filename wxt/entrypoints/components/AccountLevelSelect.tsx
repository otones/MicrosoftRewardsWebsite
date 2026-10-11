interface AccountLevelSelectProps {
    value: string;
    onChange: (level: string) => void;
}

const LEVELS: { value: string; label: string }[] = [
    { value: 'member', label: '会员' },
    { value: 'silver', label: '白银' },
    { value: 'gold', label: '黄金' },
];

// The label links to the Rewards benefits page so users can check which level
// they're on. Picking a level sets a sensible default search count.
function AccountLevelSelect({ value, onChange }: AccountLevelSelectProps) {
    return (
        <span className="field">
            <select id="accountLevel" value={value} onChange={(e) => onChange(e.target.value)}>
                {LEVELS.map((level) => (
                    <option key={level.value} value={level.value}>{level.label}</option>
                ))}
            </select>
            <label htmlFor="accountLevel">
                <a className="normal-link level-link" href="https://rewards.bing.com/about?section=benefits" target="_blank" rel="noopener noreferrer">账户等级</a>
            </label>
        </span>
    );
}

export default AccountLevelSelect;
