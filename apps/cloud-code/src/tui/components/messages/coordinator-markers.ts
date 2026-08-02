import { truncateToWidth, type Component } from '@cloud-code/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { t } from '#/tui/i18n';
import { currentTheme } from '#/tui/theme';

export type CoordinatorModeMarkerState = 'active' | 'inactive';

export class CoordinatorModeMarkerComponent implements Component {
  constructor(private readonly state: CoordinatorModeMarkerState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const token = this.state === 'inactive' ? 'textDim' : 'success';
    const marker = currentTheme.boldFg(token, STATUS_BULLET);
    const label = currentTheme.boldFg(token, coordinatorMarkerLabel(this.state));
    return ['', truncateToWidth(marker + label, safeWidth, '…')];
  }
}

function coordinatorMarkerLabel(state: CoordinatorModeMarkerState): string {
  switch (state) {
    case 'active':
      return t('coordinator.marker.activated');
    case 'inactive':
      return t('coordinator.marker.deactivated');
  }
}
