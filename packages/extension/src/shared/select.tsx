// A dropdown on base-ui's Select, for plain-DOM content scripts: keyboard,
// typeahead and screen-reader behaviour from the library, the look from the
// site's stylesheet. Classes are `${className}-trigger`, `-popup`, `-item` and so
// on; the popup portals to <body>, so its styles can't lean on the panel's.
import { Select } from '@base-ui/react/select';
import { createRoot } from 'react-dom/client';

export type SelectOption = { value: string; label: string; detail?: string };

type Props = {
  className: string;
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
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

const Picker = ({ className, label, value, options, onChange }: Props) => (
  <Select.Root
    items={options}
    defaultValue={value}
    onValueChange={(next) => {
      if (next != null) onChange(next);
    }}
  >
    <Select.Trigger className={`${className}-trigger`} aria-label={label}>
      <Select.Value className={`${className}-value`} />
      <Select.Icon className={`${className}-icon`}>
        <Chevron />
      </Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Positioner className={`${className}-positioner`} sideOffset={6} align="start" alignItemWithTrigger={false}>
        <Select.Popup className={`${className}-popup`}>
          {options.map((option) => (
            <Select.Item key={option.value} value={option.value} className={`${className}-item`}>
              <Select.ItemIndicator className={`${className}-check`}>
                <Check />
              </Select.ItemIndicator>
              <Select.ItemText className={`${className}-text`}>{option.label}</Select.ItemText>
              {option.detail && <span className={`${className}-detail`}>{option.detail}</span>}
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
