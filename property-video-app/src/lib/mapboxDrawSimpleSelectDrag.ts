/**
 * Mapbox Draw `simple_select` variant: clicking the body of an already-selected
 * line or polygon no longer jumps into `direct_select`, so users can press-drag
 * the interior to move the whole shape. Vertex / midpoint handles still open
 * `direct_select` (handled first in `clickOnVertex`).
 */

import MapboxDraw from '@mapbox/mapbox-gl-draw';

const { CommonSelectors, doubleClickZoom } = MapboxDraw.lib;
const { cursors } = MapboxDraw.constants;
const simpleSelect = MapboxDraw.modes.simple_select;

// Draw mode object: `this` is the draw context at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModeThis = any;

export const simpleSelectDragWholePolygon = {
  ...simpleSelect,
  clickOnFeature(this: ModeThis, state: unknown, e: ModeThis) {
    doubleClickZoom.disable(this);
    this.stopExtendedInteractions(state);

    const isShiftClick = CommonSelectors.isShiftDown(e);
    const selectedFeatureIds = this.getSelectedIds();
    const featureId = e.featureTarget.properties.id;
    const isFeatureSelected = this.isSelected(featureId);

    if (isFeatureSelected && isShiftClick) {
      this.deselect(featureId);
      this.updateUIClasses({ mouse: cursors.POINTER });
      if (selectedFeatureIds.length === 1) {
        doubleClickZoom.enable(this);
      }
    } else if (!isFeatureSelected && isShiftClick) {
      this.select(featureId);
      this.updateUIClasses({ mouse: cursors.MOVE });
    } else if (!isFeatureSelected && !isShiftClick) {
      selectedFeatureIds.forEach((id: string) => this.doRender(id));
      this.setSelected(featureId);
      this.updateUIClasses({ mouse: cursors.MOVE });
    }

    this.doRender(featureId);
  },
};
