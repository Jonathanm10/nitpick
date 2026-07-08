import NitpickCore
import SwiftUI

/// The session's Device Context at a glance: one compact chip showing the
/// active device, whose popover holds the device picker that governs the
/// review.
struct DeviceContextChip: View {
    @Bindable var model: AppModel
    @State private var isPopoverPresented = false

    var body: some View {
        Button {
            isPopoverPresented = true
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "iphone")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(NitpickTheme.secondaryText)
                Text("\(deviceName) — \(osName)")
                    .font(.system(size: 17, weight: .semibold))
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(NitpickTheme.secondaryText)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .background(NitpickTheme.hover, in: Capsule())
        .accessibilityLabel(accessibilityLabel)
        .popover(isPresented: $isPopoverPresented) {
            popoverContent
        }
        .motionPressFeedback()
    }

    private var deviceName: String {
        model.selectedDevice?.name ?? model.reviewDevice?.name ?? "No device selected"
    }

    private var osName: String {
        model.selectedDevice?.osName ?? model.reviewDevice?.osName ?? "runtime unknown"
    }

    private var accessibilityLabel: Text {
        Text("Device Context, \(deviceName) — \(osName)")
    }

    private var popoverContent: some View {
        DeviceContextPickerControls(model: model)
            .frame(width: 320, alignment: .leading)
            .padding(12)
    }
}

/// The session's device picker, shared by the no-session setup group and the
/// session popover so the switch semantics stay in one place.
struct DeviceContextPickerControls: View {
    @Bindable var model: AppModel

    var body: some View {
        Picker("Device", selection: deviceSelection) {
            devicePickerContent
        }
        .disabled(model.isBusy)
    }

    /// Mid-session, choosing a device is a switch: the model relaunches the
    /// Build and reverts the selection if the switch fails.
    private var deviceSelection: Binding<SimulatorDevice.ID?> {
        Binding(
            get: { model.selectedDeviceID },
            set: { id in
                if model.isReviewing {
                    Task { await model.switchDevice(to: id) }
                } else {
                    model.selectedDeviceID = id
                }
            }
        )
    }

    /// Every pickable simulator device; a device whose runtime is missing
    /// is flagged at pick time — visible but not selectable (issue 10).
    private var devicePickerContent: some View {
        ForEach(model.devices) { device in
            Text(
                device.isRuntimeAvailable
                    ? "\(device.name) — \(device.osName)"
                    : "\(device.name) — \(device.osName) (runtime missing)"
            )
            .tag(Optional(device.id))
            .selectionDisabled(!device.isRuntimeAvailable)
        }
    }
}
