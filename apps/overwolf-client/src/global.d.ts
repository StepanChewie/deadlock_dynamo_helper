declare namespace overwolf {
  namespace games {
    namespace events {
      interface SetRequiredFeaturesResult {
        success: boolean;
        error?: string | null;
        /**
         * Every feature available for the games declared in the manifest, as
         * reported by Overwolf. This was previously declared as `features`,
         * which is not a field Overwolf sends — nothing read it, so the typo
         * was invisible.
         */
        supportedFeatures?: string[];
      }
      function setRequiredFeatures(
        features: string[],
        callback: (result: SetRequiredFeaturesResult) => void
      ): void;

      interface InfoUpdates2Event {
        info: any;
        feature: string;
      }
      interface NewEventsEvent {
        events: any[];
        feature: string;
      }

      const onInfoUpdates2: {
        addListener(callback: (info: InfoUpdates2Event) => void): void;
        removeListener(callback: (info: InfoUpdates2Event) => void): void;
      };

      const onNewEvents: {
        addListener(callback: (info: NewEventsEvent) => void): void;
        removeListener(callback: (info: NewEventsEvent) => void): void;
      };
    }
  }
}
