"""Exercise the Tauri billing conversation through the Linux accessibility tree."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi


def walk(node, depth=0):
    if node is None or depth > 40:
        return
    try:
        yield node
        for index in range(node.get_child_count()):
            yield from walk(node.get_child_at_index(index), depth + 1)
    except Exception:
        # The native tree can replace a remote object while a turn settles.
        return


def view(pid):
    desktop = Atspi.get_desktop(0)
    for index in range(desktop.get_child_count()):
        child = desktop.get_child_at_index(index)
        if child is not None and child.get_process_id() == pid:
            return list(walk(child))
    return []


def wait(check, detail, timeout=40):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            value = check()
            if value is not None:
                return value
        except RuntimeError:
            pass
        time.sleep(.2)
    raise RuntimeError(detail)


def keyboard_type(command):
    """Give the isolated test window normal keyboard input on Wayland."""
    if not (shutil.which('ydotoold') and shutil.which('ydotool')):
        raise RuntimeError('Install the local ydotool test dependency for Wayland keyboard input')
    with tempfile.TemporaryDirectory(prefix='verboo-native-input-') as directory:
        socket = Path(directory) / 'keyboard.sock'
        daemon = subprocess.Popen(['ydotoold', '--mouse-off', '--socket-path', str(socket)],
                                  stdout=subprocess.DEVNULL)
        try:
            wait(lambda: socket if socket.exists() else None, 'Native keyboard test socket did not start', 5)
            # The compositor discovers a newly created input device asynchronously.
            time.sleep(.5)
            env = {**os.environ, 'YDOTOOL_SOCKET': str(socket)}
            subprocess.run(['ydotool', 'key', '29:1', '30:1', '30:0', '29:0'],
                           env=env, check=True, timeout=5)
            subprocess.run(['ydotool', 'type', command], env=env, check=True, timeout=10)
        finally:
            daemon.terminate()
            try:
                daemon.wait(5)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait(5)


def run(pid):
    Atspi.init()

    def find_labels(names):
        return next((node for node in view(pid) if node.get_name() in names), None)

    def find_text(match):
        for node in view(pid):
            if match(node.get_name() or ''):
                return node
            if node.get_role_name() in {'paragraph', 'section', 'static', 'text'} and node.get_text_iface() is not None:
                if match(Atspi.Text.get_text(node, 0, -1) or ''):
                    return node
        return None

    def click(names):
        button = wait(lambda: find_labels(names), 'Missing button ' + repr(names))
        if not button.get_action_iface().do_action(0):
            raise RuntimeError('Unable to click ' + button.get_name())

    def send(command):
        prompt = command + ' QA_NATIVE'

        def editor():
            return next((node for node in view(pid)
                         if node.get_role_name() == 'entry' and
                         node.get_state_set().contains(Atspi.StateType.EDITABLE) and
                         'search' not in (node.get_name() or '').lower() and
                         'buscar' not in (node.get_name() or '').lower()), None)

        node = wait(editor, 'Native conversation editor is unavailable')
        component = node.get_component_iface()
        if component is None or not component.grab_focus():
            raise RuntimeError('Native composer could not receive focus')
        def send_button():
            button = find_labels({'Send message', 'Enviar mensagem'})
            return button if button is not None and button.get_state_set().contains(Atspi.StateType.SENSITIVE) else None

        field = node.get_editable_text_iface()
        if field is not None:
            field.set_text_contents(prompt)
        if send_button() is None:
            if os.environ.get('WAYLAND_DISPLAY'):
                frame = next((element for element in view(pid) if element.get_role_name() == 'frame'), None)
                if frame is None or not frame.get_state_set().contains(Atspi.StateType.ACTIVE):
                    raise RuntimeError('The isolated Tauri test window must be active for keyboard input')
                if not node.get_state_set().contains(Atspi.StateType.FOCUSED):
                    raise RuntimeError('The isolated composer lost keyboard focus')
                keyboard_type(prompt)
            elif not Atspi.generate_keyboard_event(0, prompt, Atspi.KeySynthType.STRING):
                raise RuntimeError('Native editor could not enter the test prompt')

        button = wait(send_button, 'Native send action did not enable after entering the prompt', 10)
        if not button.get_action_iface().do_action(0):
            raise RuntimeError('Native send action failed')

    def result(command):
        marker = command + '_NATIVE_OK'
        wait(lambda: find_text(lambda value: value.strip() == marker), 'Missing native result ' + command)
        print('Tauri conversation verified:', command, flush=True)

    wait(lambda: find_labels({'New conversation', 'Nova conversa'}), 'The native workspace did not open')
    if find_labels({'Open navigation', 'Abrir navegação'}) is not None:
        click({'Open navigation', 'Abrir navegação'})
    conversation = wait(
        lambda: next((node for node in view(pid) if node.get_role_name() == 'button' and
                      (node.get_name() or '').startswith('Acesso ao MCP GitHub via Composio')), None),
        'The isolated browser QA conversation was not restored in the native workspace',
    )
    if not conversation.get_action_iface().do_action(0):
        raise RuntimeError('Unable to reopen the test conversation in Tauri')
    wait(lambda: next((node for node in view(pid) if node.get_role_name() == 'entry' and
                       (node.get_name() or '').startswith(('Message or run', 'Envie uma mensagem', 'Mensagem'))), None),
         'The writable conversation composer did not load in Tauri')
    for command in ['QA_PLAN_STATUS', 'QA_PLAN_FOREIGN', 'QA_PLAN_PREVIEW']:
        send(command)
        result(command)
    send('QA_PLAN_DENY')
    wait(lambda: find_text(lambda value: '«Verboo Max»' in value and ('190.00' in value or '190,00' in value)),
         'Native approval is missing the plan and price')
    click({'Reject', 'Rejeitar'})
    result('QA_PLAN_DENY')
    send('QA_PLAN_CHANGE')
    click({'Allow once', 'Permitir uma vez'})
    result('QA_PLAN_CHANGE')
    send('QA_PLAN_CANCEL')
    wait(lambda: find_text(lambda value: value.startswith(('Stop renewing «Verboo Pro»', 'Cancelar a renovação de «Verboo Pro»'))),
         'Native confirmation is missing the cancellation consequence')
    click({'Allow once', 'Permitir uma vez'})
    result('QA_PLAN_CANCEL')


if __name__ == '__main__':
    pid = int(sys.argv[1])
    try:
        run(pid)
    except RuntimeError:
        print('Native accessibility surface:', flush=True)
        for element in view(pid):
            print(element.get_role_name(), (element.get_name() or '')[:140], flush=True)
        raise
