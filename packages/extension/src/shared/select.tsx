// A dropdown on base-ui's Select, for plain-DOM content scripts: keyboard,
// typeahead and screen-reader behaviour from the library, the look from the
// site's stylesheet. Classes are `${className}-trigger`, `-popup`, `-item` and so
// on, beside the shared `ts-select-*` ones; the list portals to <body> and takes
// select.css's dark or light theme.
import { Select } from '@base-ui/react/select';
import { createRoot } from 'react-dom/client';

export type SelectOption = { value: string; label: string; detail?: string };

type Props = {
  className: string;
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  theme?: 'dark' | 'light';
};

const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const Picker = ({ className, label, value, options, onChange, theme = 'dark' }: Props) => (
  <Select.Root
    items={options}
    defaultValue={value}
    onValueChange={(next) => {
      if (next != null) onChange(next);
    }}
  >
    <Select.Trigger className={`ts-select-trigger ${className}-trigger`} aria-label={label}>
      <Select.Value className={`ts-select-value ${className}-value`} />
      <Select.Icon className={`ts-select-icon ${className}-icon`}>
        <Chevron />
      </Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Positioner className="ts-select-positioner" sideOffset={6} align="start" alignItemWithTrigger={false}>
        <Select.Popup className="ts-select-popup" data-theme={theme}>
          {options.map((option) => (
            <Select.Item key={option.value} value={option.value} className="ts-select-item">
              <Select.ItemIndicator className="ts-select-check">
                <Check />
              </Select.ItemIndicator>
              <Select.ItemText className="ts-select-text">{option.label}</Select.ItemText>
              {option.detail && <span className="ts-select-detail">{option.detail}</span>}
            </Select.Item>
          ))}
        </Select.Popup>
      </Select.Positioner>
    </Select.Portal>
  </Select.Root>
);

// The host element holds the trigger; the caller places it.
export const mountSelect = (props: Props): HTMLElement => {
  const host = document.createElement('div');
  host.className = props.className;
  createRoot(host).render(<Picker {...props} />);

  return host;
};
