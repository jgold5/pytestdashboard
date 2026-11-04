import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemePref } from '../lib/theme';
import { Menu, MenuContent, MenuItem, MenuTrigger } from './ui/dropdown';
import { Button } from './ui/button';

const OPTIONS: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export function ThemeToggle() {
  const { pref, resolved, setPref } = useTheme();
  const Icon = resolved === 'dark' ? Moon : Sun;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Theme: ${pref}. Change theme`}>
          <Icon />
        </Button>
      </MenuTrigger>
      <MenuContent className="min-w-36">
        {OPTIONS.map((o) => (
          <MenuItem key={o.value} onSelect={() => setPref(o.value)}>
            <o.icon />
            <span className="flex-1">{o.label}</span>
            {pref === o.value ? <span className="text-xs text-accent">✓</span> : null}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
